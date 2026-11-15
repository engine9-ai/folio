import { ValidationError } from './errors.js';
import { emailAddress } from './email.js';
import { findCredentials } from './privacy.js';

/**
 * Context for the work in a folder (SPEC 3.1.3): what an agent or a new teammate needs on every piece of work for a
 * client, set once on the client's folder and inherited by every folio inside it. A folder keeps it in
 * `folder.json`, beside its README.md; `AGENTS.md` beside them holds instructions for agents.
 *
 *   folder.json
 *   { "format": "folio.folder",
 *     "connections": [ { "type": "engine9", "alias": "habitat", "account_id": "allegiance_habitat", "parent_account_id": "allegiance" },
 *                      { "type": "mcp", "alias": "engine9-data", "url": "https://data.engine9.ai/mcp" },
 *                      { "type": "sftp", "alias": "hfhi-drop", "role": "source", "host": "sftp.example.org", "folder": "/out", "pattern": "IMOE_*.dat", "credentials": "1Password: Clients/HFHI SFTP" },
 *                      { "type": "luminate", "alias": "hfhi-lo", "role": "destination", "site": "hfhi", "credentials": "1Password: Clients/HFHI LO admin" } ],
 *     "contacts": [ { "name": "Tim Thornburg", "email": "tim@example.org", "role": "VP Data", "answers": "file layouts, test data" } ],
 *     "client_approvers": ["chris@example.com"],
 *     "updated_at", "updated_by" }
 *
 * A connection is a reference, like a folio's (folio.json `connections`): type and alias, then whatever names it
 * (an account id, a URL, a host). Never a secret: `credentials` says where one lives (a password-manager item).
 * Folders inherit from the folders above them; a nearer folder's connection with the same alias wins, and a folio's
 * own `connections` win over them all. `client_approvers`, when set, are the only people who may send messages to
 * the client from folios inside (SPEC 5.7.3).
 */

export const FOLDER_FILE = 'folder.json';
export const FOLDER_FORMAT = 'folio.folder';
export const AGENTS_FILE = 'AGENTS.md';
export const MAX_CONNECTIONS = 40;
export const MAX_CONTACTS = 60;
const MAX_VALUE = 500;

/** The slots review_folio shows, so an agent asks for exactly what is missing at the start. */
export const CONTEXT_SLOTS = Object.freeze([
  { key: 'engine9_account', label: 'engine9 account', test: (c) => c.connections.some((x) => x.type === 'engine9'), hint: 'a connection { type: "engine9", alias, account_id, parent_account_id? }' },
  { key: 'mcp', label: 'MCP endpoint', test: (c) => c.connections.some((x) => x.type === 'mcp'), hint: 'a connection { type: "mcp", alias, url }' },
  { key: 'source', label: 'Source systems', test: (c) => c.connections.some((x) => x.role === 'source'), hint: 'connections with role "source" (SFTP host, folder, file pattern, credentials: the password-manager item)' },
  { key: 'destination', label: 'Destination systems', test: (c) => c.connections.some((x) => x.role === 'destination'), hint: 'connections with role "destination" (CRM site, credentials: the password-manager item)' },
  { key: 'contacts', label: 'Client contacts and roles', test: (c) => c.contacts.length > 0, hint: 'contacts [{ name, email, role, answers }]' },
  { key: 'client_approvers', label: 'Client message approvers', test: (c) => c.client_approvers.length > 0, hint: 'client_approvers: staff emails who approve and send client messages' },
  { key: 'agent_instructions', label: 'Agent instructions', test: (c) => c.agents.length > 0, hint: 'an AGENTS.md on the client folder' },
]);

const SECRET_KEY = /^(?:pass(?:word|wd|phrase)?|secret|client_secret|token|access_token|refresh_token|api_?key|private_?key|pin)$/i;

function cleanValue(v, where) {
  if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return v;
  if (typeof v !== 'string') throw new ValidationError(`${where} must be text, a number or true/false`);
  const s = v.trim();
  if (s.length > MAX_VALUE) throw new ValidationError(`${where} is longer than ${MAX_VALUE} characters`);
  if (findCredentials(s).length) throw new ValidationError(`${where} looks like a secret. Write where it lives (a password-manager item) instead`);
  return s;
}

/** One connection: { type, alias, ...references }. */
export function normalizeConnection(c, i = 0) {
  const where = `connections[${i}]`;
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new ValidationError(`${where} must be an object with type and alias`);
  const out = {};
  for (const [k, v] of Object.entries(c)) {
    if (k === 'from') continue;
    if (!/^[a-z][a-z0-9_]{0,40}$/i.test(k)) throw new ValidationError(`${where}: "${k}" is not a usable field name`);
    if (SECRET_KEY.test(k)) throw new ValidationError(`${where}.${k}: no secrets in Folio. Use "credentials" to say where it lives (a password-manager item)`);
    if (v === undefined) continue;
    out[k] = cleanValue(v, `${where}.${k}`);
  }
  for (const k of ['type', 'alias']) if (typeof out[k] !== 'string' || !out[k]) throw new ValidationError(`${where} needs ${k}`);
  out.type = out.type.toLowerCase();
  if (out.role !== undefined && !['source', 'destination', 'both', 'tool'].includes(out.role)) throw new ValidationError(`${where}.role is source, destination, both or tool`);
  return out;
}

function normalizeContact(c, i) {
  const where = `contacts[${i}]`;
  if (typeof c === 'string') c = { email: c };
  if (!c || typeof c !== 'object') throw new ValidationError(`${where} must be { name, email, role, answers }`);
  const out = {};
  for (const k of ['name', 'email', 'role', 'answers', 'phone']) if (c[k] !== undefined && c[k] !== null && c[k] !== '') out[k] = cleanValue(String(c[k]), `${where}.${k}`);
  if (out.email) {
    const e = emailAddress(out.email);
    if (!e) throw new ValidationError(`${where}.email is not an email address`);
    out.email = e;
  }
  if (!out.name && !out.email) throw new ValidationError(`${where} needs a name or an email`);
  return out;
}

const emails = (list, where) =>
  [...new Set([].concat(list || []).map((x) => {
    const e = emailAddress(String(x || ''));
    if (!e) throw new ValidationError(`${where}: "${x}" is not an email address`);
    return e;
  }))];

/** A folder's context, checked: { format, connections, contacts, client_approvers }. */
export function normalizeFolderContext(input = {}) {
  const conns = [].concat(input.connections || []);
  if (conns.length > MAX_CONNECTIONS) throw new ValidationError(`At most ${MAX_CONNECTIONS} connections`);
  const connections = conns.map(normalizeConnection);
  const aliases = new Set();
  for (const c of connections) {
    if (aliases.has(c.alias.toLowerCase())) throw new ValidationError(`Two connections are called ${c.alias}`);
    aliases.add(c.alias.toLowerCase());
  }
  const people = [].concat(input.contacts || []);
  if (people.length > MAX_CONTACTS) throw new ValidationError(`At most ${MAX_CONTACTS} contacts`);
  return { format: FOLDER_FORMAT, connections, contacts: people.map(normalizeContact), client_approvers: emails(input.client_approvers, 'client_approvers') };
}

/**
 * Apply a change to a folder's context: `connections` (add or replace by alias), `remove_connections` (aliases),
 * `contacts` (add or replace by email, else by name), `remove_contacts` (emails or names), `client_approvers`
 * (the whole list; [] clears it). Returns the new context.
 */
export function changeFolderContext(current = {}, patch = {}) {
  const cur = normalizeFolderContext(current);
  const drop = new Set([].concat(patch.remove_connections || []).map((a) => String(a).toLowerCase()));
  let connections = cur.connections.filter((c) => !drop.has(c.alias.toLowerCase()));
  for (const [i, raw] of [].concat(patch.connections || []).entries()) {
    const c = normalizeConnection(raw, i);
    connections = [...connections.filter((x) => x.alias.toLowerCase() !== c.alias.toLowerCase()), c];
  }
  const same = (a, b) => (a.email && b.email ? a.email === b.email : String(a.name || '').toLowerCase() === String(b.name || '').toLowerCase());
  const gone = [].concat(patch.remove_contacts || []).map((x) => String(x).toLowerCase());
  let contacts = cur.contacts.filter((c) => !gone.includes(String(c.email || '').toLowerCase()) && !gone.includes(String(c.name || '').toLowerCase()));
  for (const [i, raw] of [].concat(patch.contacts || []).entries()) {
    const c = normalizeContact(raw, i);
    const had = contacts.find((x) => same(x, c));
    contacts = had ? contacts.map((x) => (x === had ? { ...had, ...c } : x)) : [...contacts, c];
  }
  const client_approvers = patch.client_approvers !== undefined ? patch.client_approvers : cur.client_approvers;
  return normalizeFolderContext({ connections, contacts, client_approvers });
}

/**
 * The context a folio works in: its folders' contexts, nearest last (`layers`: [{ path, context, agents }], top
 * first, where `agents` is true when that folder has an AGENTS.md), then the folio's own connections and AGENTS.md.
 * Returns { connections, contacts, client_approvers, agents, slots: { set, unset } }, each connection and contact
 * with `from` (the folder it was set on, or "folio").
 */
export function mergeContext(layers = [], { connections: own = [], agents: ownAgents = false, path = null } = {}) {
  const byAlias = new Map();
  const contacts = new Map();
  let client_approvers = [];
  let approvers_from = null;
  const agents = [];
  for (const layer of layers) {
    const ctx = layer.context || {};
    for (const c of ctx.connections || []) byAlias.set(String(c.alias).toLowerCase(), { ...c, from: layer.path });
    for (const c of ctx.contacts || []) contacts.set(c.email || `name:${String(c.name).toLowerCase()}`, { ...c, from: layer.path });
    if ((ctx.client_approvers || []).length) {
      client_approvers = ctx.client_approvers;
      approvers_from = layer.path;
    }
    if (layer.agents) agents.push({ path: `${layer.path}/${AGENTS_FILE}`, from: layer.path });
  }
  for (const c of own || []) byAlias.set(String(c.alias).toLowerCase(), { ...c, from: 'folio' });
  if (ownAgents) agents.push({ path: AGENTS_FILE, from: 'folio', ...(path ? { folder: path } : {}) });
  const merged = { connections: [...byAlias.values()], contacts: [...contacts.values()], client_approvers, approvers_from, agents };
  const set = [];
  const unset = [];
  for (const s of CONTEXT_SLOTS) (s.test(merged) ? set : unset).push(s.key);
  return { ...merged, slots: { set, unset: unset.map((k) => ({ key: k, label: CONTEXT_SLOTS.find((s) => s.key === k).label, how: CONTEXT_SLOTS.find((s) => s.key === k).hint })) } };
}
