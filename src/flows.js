import { NotFoundError, ValidationError } from './errors.js';
import { findCredentials } from './privacy.js';

/**
 * Flow listing (SPEC 3.2.2): the flows built or changed to do a folio's work, in folio.json `flows`. Like a
 * repository listing, every entry is a reference: the definition lives on the execution platform (engine9) or in a
 * repository, never in the folio, and nothing here runs anything. Runs of a flow are tasks (SPEC 5.8).
 *
 *   { "account_id": "acme_main",                 the engine9 account the flow belongs to
 *     "flow_id": "6af4ad12...",                  the platform's id, once it is published there
 *     "source": "engine9-accounts/acme/acme_main/import/import.flow.json5",   where its file lives
 *     "name": "Import donors", "purpose": "Nightly SFTP file to the CRM",
 *     "added_at", "added_by", "updated_at" }
 *
 * `account_id` and one of `flow_id` or `source` are required. A flow recorded by `source` while it is being built
 * gains its `flow_id` when it is published: adding it again with the same source updates the entry.
 */

export const MAX_FLOWS = 40;
const FIELDS = ['account_id', 'flow_id', 'source', 'name', 'purpose'];
const LIMITS = { account_id: 100, flow_id: 100, source: 500, name: 200, purpose: 500 };
const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const FLOW_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;

const text = (v) => (v === undefined || v === null ? '' : String(v).trim());

/** A flow entry, checked. Unknown fields are kept (SPEC 3.4). */
export function normalizeFlow(input, { now = new Date().toISOString() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('A flow is { account_id, flow_id or source, name, purpose }');
  const out = {};
  for (const k of FIELDS) {
    const v = text(input[k]);
    if (!v) continue;
    if (v.length > LIMITS[k]) throw new ValidationError(`flow ${k} is longer than ${LIMITS[k]} characters`);
    if (findCredentials(v).length) throw new ValidationError(`flow ${k} looks like a secret`);
    out[k] = v;
  }
  if (!out.account_id || !ACCOUNT_ID.test(out.account_id)) throw new ValidationError('A flow needs account_id: the engine9 account it belongs to');
  if (!out.flow_id && !out.source) throw new ValidationError('A flow needs flow_id (its id on the platform) or source (where its file lives)');
  if (out.flow_id && !FLOW_ID.test(out.flow_id)) throw new ValidationError('flow_id is not a usable id');
  if (out.source && /\/\/[^/@\s]+:[^/@\s]+@/.test(out.source)) throw new ValidationError('flow source must not embed credentials');
  for (const k of ['added_by', 'updated_at']) if (input[k] !== undefined) out[k] = input[k];
  out.added_at = input.added_at || now;
  for (const [k, v] of Object.entries(input)) if (!(k in out) && v !== undefined && v !== null && v !== '') out[k] = v;
  return out;
}

/** Whether two entries are the same flow: same account, and the same flow_id or the same source. */
export function sameFlow(a, b) {
  if (!a || !b || a.account_id !== b.account_id) return false;
  if (a.flow_id && b.flow_id) return a.flow_id === b.flow_id;
  return Boolean(a.source && b.source && a.source === b.source);
}

export function validateFlows(list) {
  const problems = [];
  if (list === undefined) return problems;
  if (!Array.isArray(list)) return [{ level: 'error', code: 'flows_not_array', path: 'folio.json#flows', message: 'flows must be an array' }];
  if (list.length > MAX_FLOWS) problems.push({ level: 'error', code: 'flows_too_many', path: 'folio.json#flows', message: `At most ${MAX_FLOWS} flows` });
  list.forEach((f, i) => {
    const path = `folio.json#flows[${i}]`;
    const err = (code, message) => problems.push({ level: 'error', code, path, message });
    if (!f || typeof f !== 'object' || Array.isArray(f)) return err('flow_not_object', 'Flow entry must be an object');
    if (typeof f.account_id !== 'string' || !ACCOUNT_ID.test(f.account_id)) err('flow_account', 'A flow needs account_id');
    if (typeof f.flow_id !== 'string' && typeof f.source !== 'string') err('flow_reference', 'A flow needs flow_id or source');
    const dup = list.findIndex((o, j) => j < i && sameFlow(o, f));
    if (dup >= 0) problems.push({ level: 'warning', code: 'flow_duplicate', path, message: `Duplicate of flows[${dup}]` });
  });
  return problems;
}

/**
 * Add a flow, or update the entry for the same flow (new fields win; added_at and added_by stay). Returns
 * { flows, flow, added }.
 */
export function upsertFlowIn(list = [], input, { now = new Date().toISOString(), actor = null } = {}) {
  const entry = normalizeFlow(input, { now });
  const i = list.findIndex((f) => sameFlow(f, entry));
  if (i < 0) {
    if (list.length >= MAX_FLOWS) throw new ValidationError(`At most ${MAX_FLOWS} flows on a folio`);
    if (actor?.id && !entry.added_by) entry.added_by = actor.id;
    return { flows: [...list, entry], flow: entry, added: true };
  }
  const had = list[i];
  const flow = { ...had, ...entry, added_at: had.added_at || entry.added_at, ...(had.added_by ? { added_by: had.added_by } : {}), updated_at: now };
  return { flows: list.map((f, j) => (j === i ? flow : f)), flow, added: false };
}

/** Remove a flow by { account_id?, flow_id | source }. Throws when none matches. */
export function removeFlowFrom(list = [], ref = {}) {
  const flowId = text(ref.flow_id);
  const source = text(ref.source);
  const account = text(ref.account_id);
  if (!flowId && !source) throw new ValidationError('Give flow_id or source');
  const hit = (f) => (!account || f.account_id === account) && ((flowId && f.flow_id === flowId) || (source && f.source === source));
  const flows = list.filter((f) => !hit(f));
  if (flows.length === list.length) throw new NotFoundError('That flow entry');
  return flows;
}
