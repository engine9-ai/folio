import { validateManifest } from './manifest.js';
import { findCycle, validateTicket } from './tickets.js';

const TEXT_EXT = /\.(md|json|txt|eml|csv|html|css|js)$/i;

/** Heuristic only. Spec 3.4(6): credentials must never be required inside a folio. */
const SECRET_PATTERNS = [
  ['github_token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['private_key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['aws_access_key', /\bAKIA[0-9A-Z]{16}\b/],
  ['bearer_token', /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}/],
  ['api_key_assignment', /\b(?:api[_-]?key|secret|token|password)["']?\s*[:=]\s*["'][A-Za-z0-9._~+/=-]{16,}["']/i],
];

/**
 * Validate a folio folder: manifest, tickets, relationships, references and
 * obvious secrets. Never throws for a bad folio; returns problems instead.
 * `ok` is false only when there is at least one error.
 */
export async function validateFolio(fs) {
  const problems = [];
  const add = (level, code, path, message) => problems.push({ level, code, path, message });

  // Manifest
  const mf = await fs.read('folio.json');
  if (!mf) add('error', 'missing_manifest', 'folio.json', 'folio.json is required');
  else {
    try {
      problems.push(...validateManifest(JSON.parse(mf.text)));
    } catch (e) {
      add('error', 'manifest_json', 'folio.json', `Not valid JSON: ${e.message}`);
    }
  }
  if (!(await fs.exists('README.md'))) add('error', 'missing_readme', 'README.md', 'README.md is required');

  // Tickets
  const files = await fs.list();
  const ticketIds = [...new Set(files.map((f) => /^tickets\/(TK-\d+)\//.exec(f)?.[1]).filter(Boolean))].sort();
  const tickets = [];
  for (const id of ticketIds) {
    const path = `tickets/${id}/ticket.json`;
    const cur = await fs.read(path);
    if (!cur) {
      add('error', 'ticket_missing_json', path, `${id} has files but no ticket.json`);
      continue;
    }
    let t;
    try {
      t = JSON.parse(cur.text);
    } catch (e) {
      add('error', 'ticket_json', path, `Not valid JSON: ${e.message}`);
      continue;
    }
    if (t.id !== id) add('error', 'ticket_id_mismatch', path, `Folder is ${id} but ticket.json says ${t.id}`);
    problems.push(...validateTicket(t, path));
    tickets.push(t);

    // Events: history written inside the folder. Edits made outside the application
    // cannot be attested, so a gap is a warning, never silently "audited".
    const evFiles = files.filter((f) => f.startsWith(`tickets/${id}/events/`) && f.endsWith('.json'));
    const revs = [];
    for (const ef of evFiles) {
      try {
        revs.push(JSON.parse((await fs.read(ef)).text).revision);
      } catch {
        add('warning', 'event_json', ef, 'Event file is not valid JSON');
      }
    }
    const maxRev = revs.length ? Math.max(...revs) : 0;
    if (Number.isInteger(t.revision)) {
      if (maxRev > t.revision) add('warning', 'uncommitted_event', path, `History records revision ${maxRev} but the ticket is at ${t.revision}`);
      if (t.revision > maxRev) add('warning', 'unattested_change', path, `Ticket is at revision ${t.revision} but history only covers ${maxRev}: changes may have been made outside the application`);
    }

    // Links to files inside the folio
    for (const l of t.links || []) {
      if (l && typeof l.path === 'string' && !(await fs.exists(l.path))) add('error', 'broken_reference', path, `Link target ${l.path} does not exist in this folio`);
    }
  }

  // Relationships
  const known = new Set(tickets.map((t) => t.id));
  for (const t of tickets) {
    for (const r of t.relationships || []) {
      if (r && r.target && !known.has(r.target)) add('error', 'broken_reference', `tickets/${t.id}/ticket.json`, `${t.id} ${r.type} ${r.target}, which does not exist`);
    }
  }
  for (const type of ['parent', 'blocked_by']) {
    const cycle = findCycle(tickets, type);
    if (cycle) add('error', 'relationship_cycle', 'tickets', `${type} loop: ${cycle.join(' → ')}`);
  }

  // Secrets
  for (const path of files) {
    if (!TEXT_EXT.test(path)) continue;
    const cur = await fs.read(path);
    if (!cur || cur.text.length > 512_000) continue;
    for (const [name, re] of SECRET_PATTERNS) {
      if (re.test(cur.text)) add('error', 'possible_secret', path, `Looks like a credential (${name}). Folios must not contain credentials.`);
    }
  }

  return { ok: !problems.some((p) => p.level === 'error'), problems };
}
