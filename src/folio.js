import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { FOLIO_STATUS_PATTERN, createManifest, newFolioId, validateManifest } from './manifest.js';
import { addRepositoryTo, describeRepository, removeRepositoryFrom, repositoryKey } from './repositories.js';
import { RELATIONSHIP_TYPES, RESERVED_TYPES, RESERVED_TYPE_MESSAGE, isFolioId, normalizeTags, readiness, wouldCycle } from './relations.js';
import { validateFolio } from './validate.js';
import { addItem, classify, createUnique, intakeChoices, slugify, writeIntakeRecord } from './intake.js';
import { parseEmail } from './email.js';
import { scrubText } from './privacy.js';
import { ExcludingFs, canHoldFolio, nestedFolioDirs } from './nested.js';
import { SubFs, normalizePath } from './fs.js';
import { TEXT_FORMATS, textFormatOf } from './text-format.js';
import { parseJsonText, planImport } from './import.js';
import { COMMS_DIR, clientThread, isEmailPath, postMessage, readComms, setHiddenFromClient } from './comms.js';
import { TASKS_DIR, TASK_FILE, TASK_OUTPUT_FILE, applyTaskUpdate, createTaskRecord, environmentLabel, isTaskId, isTerminalState, taskDirName, taskOutputText, taskStateLabel, taskSummary, taskTarget } from './tasks.js';
import { CHECKLIST_FILE, checklistCounts, editChecklistText, findItem, parseChecklist } from './checklist.js';
import { CC_AUDIENCES, MAX_CC, ccAudience, ccAuthor, ccKey, findCc, normalizeCc, parseCc } from './cc.js';

const json = (o) => JSON.stringify(o, null, 2) + '\n';
const TEXT_EXT = /\.(md|json|txt|eml|csv|html|css|js)$/i;

/** Fields of folio.json that people and agents edit directly (edit()). */
export const EDITABLE = ['title', 'summary', 'type', 'status', 'owner', 'target_date', 'tags', 'outcome', 'resolution', 'waiting_on', 'hold', 'links'];

const defaultActor = { type: 'unknown' };

/** What someone typed as a CC, read for matching; null when it is not one. */
function tryParse(s) {
  try {
    return parseCc(s);
  } catch {
    return null;
  }
}

/** The index of the entry `input` names (a key, an address, or { channel, address }), or -1. */
function ccIndex(list, input) {
  if (typeof input === 'string') {
    const k = list.findIndex((c) => ccKey(c) === input);
    if (k >= 0) return k;
  }
  const want = typeof input === 'string' ? tryParse(input) : input;
  const hit = want ? findCc(list, want) : null;
  return hit ? list.indexOf(hit) : -1;
}

/** Where an imported folio came from: { source, id, url?, ... } with string values, or null. */
export function externalOf(x) {
  if (!x || typeof x !== 'object' || typeof x.source !== 'string' || x.id === undefined || x.id === null) return null;
  const out = {};
  for (const [k, v] of Object.entries(x)) if (['string', 'number', 'boolean'].includes(typeof v)) out[k] = typeof v === 'string' ? v.slice(0, 500) : v;
  out.id = String(x.id);
  return out;
}

/** Map over items with at most `n` in flight: reads from object stores are slow one by one, fast together. */
export async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}
const READS = 16;

/** What changed between two manifests, for the change history: { field: { from, to } }. */
function diff(before, after) {
  const out = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (k === 'updated_at') continue;
    const a = JSON.stringify(before[k]);
    const b = JSON.stringify(after[k]);
    if (a !== b) out[k] = { from: before[k] ?? null, to: after[k] ?? null };
  }
  return out;
}

/** A folder name for a new folio inside this one, from its title; never one of Folio's own folders. */
function childDirName(title) {
  const base = slugify(String(title || ''), 50) || 'folio';
  return canHoldFolio(base) ? base : `${base}-folio`;
}

export class Folio {
  /**
   * @param fs          a FolioFs (MemoryFs, NodeFs, or a hosted store)
   * @param hold        optional temporary storage for originals a folio must not keep (data files, logs, emails
   *                    carrying card numbers): { put(bytes, { name, type, sha256, actor, via }) -> { store, key, expires_at } }.
   * @param nested      folders inside this folio that are folios of their own (nested.js). Their files are hidden from
   *                    this folio. Folio.open(fs, { nested: 'detect' }) finds them.
   * @param onManifest  called with the new manifest after this folio writes folio.json (hosts keep an index).
   * @param onChild     called with { id, dir, manifest } after a folio is created inside this one (hosts register it).
   * @param onMessage   called with each new message after it is written to comms/ ({ path, kind, at, author, text, ... };
   *                    for an email also { subject, from, to }). Hosts use it to pass messages on to the folio's CCs.
   * @param onChecklist called with the checklist's counts ({ done, total }, or null) after it changes (hosts show them on cards).
   */
  constructor(fs, { now = () => new Date().toISOString(), hold = null, nested = [], onManifest = null, onChild = null, onMessage = null, onChecklist = null } = {}) {
    this.root = fs;
    this.nested = Array.isArray(nested) ? nested.map((d) => normalizePath(d)) : [];
    this.fs = this.nested.length ? new ExcludingFs(fs, this.nested) : fs;
    this.now = now;
    this.hold = hold;
    this.onManifest = onManifest;
    this.onChild = onChild;
    this.onMessage = onMessage;
    this.onChecklist = onChecklist;
  }

  /** Create a minimal folio: folio.json + README.md. Fails if one already exists here. */
  static async init(fs, { title, summary, status, id, tags, readme, description, now = () => new Date().toISOString(), actor = defaultActor, via = 'folio-lib', ...fields } = {}) {
    if (!title || !String(title).trim()) throw new ValidationError('A folio needs a title');
    if (RESERVED_TYPES.includes(String(fields.type || '').trim().toLowerCase())) throw new ValidationError(RESERVED_TYPE_MESSAGE);
    const clean = (v) => (typeof v === 'string' ? scrubText(v).text.trim() || undefined : v);
    summary = clean(summary);
    description = clean(description);
    if (typeof readme === 'string') readme = scrubText(readme).text;
    for (const k of ['outcome', 'resolution', 'waiting_on']) fields[k] = clean(fields[k]);
    const extra = {};
    for (const k of ['type', 'owner', 'target_date', 'outcome', 'resolution', 'links', 'relationships', 'external', 'aliases', 'waiting_on']) if (fields[k] !== undefined && fields[k] !== null && fields[k] !== '') extra[k] = fields[k];
    const t = normalizeTags(tags);
    const manifest = createManifest({ title: String(title).trim(), summary, status, id, now: now(), ...(t.length ? { tags: t } : {}), ...extra });
    const bad = validateManifest(manifest).filter((p) => p.level === 'error');
    if (bad.length) throw new ValidationError(bad);
    await fs.write('folio.json', json(manifest), { ifMatch: null });
    const body = readme || `# ${manifest.title}\n\n${description ? `${String(description).trim()}\n` : `${summary || 'Describe why this folio exists and what a good outcome looks like.'}\n`}`;
    await fs.write('README.md', body, { ifMatch: null });
    const f = new Folio(fs, { now });
    await f.recordChange({ type: 'created', changes: {} }, { actor, via });
    return f;
  }

  static async open(fs, opts = {}) {
    const nested = opts.nested === 'detect' ? await nestedFolioDirs(fs) : opts.nested;
    const f = new Folio(fs, { ...opts, nested });
    await f.manifest();
    return f;
  }

  async manifest() {
    const cur = await this.fs.read('folio.json');
    if (!cur) throw new NotFoundError('folio.json');
    let manifest;
    try {
      manifest = JSON.parse(cur.text);
    } catch (e) {
      throw new ValidationError(`folio.json is not valid JSON: ${e.message}`);
    }
    return { manifest, etag: cur.etag };
  }

  /** A record in history/changes/: who changed what in folio.json, and when. */
  async recordChange(entry, { actor = defaultActor, via = 'folio-lib' } = {}) {
    const at = this.now();
    const stamp = at.replace(/[-:]/g, '').replace(/\.(\d+)Z$/, '$1Z');
    return createUnique(this.fs, 'history/changes', `${stamp}.json`, json({ at, actor, via, ...entry }), 'application/json');
  }

  /** Change fields of folio.json. Every change is recorded in history/changes/. Undefined values remove a field. */
  async updateManifest(patch, { ifMatch, actor = defaultActor, via = 'folio-lib' } = {}) {
    const { manifest, etag } = await this.manifest();
    const next = JSON.parse(JSON.stringify({ ...manifest, ...patch, updated_at: this.now() }));
    const bad = validateManifest(next).filter((p) => p.level === 'error');
    if (bad.length) throw new ValidationError(bad);
    const changes = diff(manifest, next);
    if (!Object.keys(changes).length) return manifest;
    await this.fs.write('folio.json', json(next), { ifMatch: ifMatch ?? etag });
    await this.recordChange({ type: 'updated', changes }, { actor, via });
    if (this.onManifest) await this.onManifest(next);
    return next;
  }

  /** Edit the fields people work with (EDITABLE): title, status, type, owner, target date, tags... */
  async edit(patch, { actor = defaultActor, via = 'folio-lib', ifMatch } = {}) {
    const clean = {};
    for (const [k, v] of Object.entries(patch || {})) {
      if (!EDITABLE.includes(k)) throw new ValidationError(`${k} cannot be edited this way (editable: ${EDITABLE.join(', ')})`);
      if (k === 'tags') clean.tags = normalizeTags(v).length ? normalizeTags(v) : undefined;
      else if (k === 'status' || k === 'type') clean[k] = v ? String(v).trim().toLowerCase() : undefined;
      else if (typeof v === 'string') clean[k] = k === 'title' ? v.trim() : scrubText(v).text.trim() || undefined;
      else clean[k] = v ?? undefined;
    }
    if (clean.type && RESERVED_TYPES.includes(clean.type)) throw new ValidationError(RESERVED_TYPE_MESSAGE);
    if (clean.status !== undefined && !FOLIO_STATUS_PATTERN.test(clean.status)) throw new ValidationError(`“${patch.status}” is not a status`);
    if ('title' in clean && !clean.title) throw new ValidationError('A folio needs a title');
    return this.updateManifest(clean, { actor, via, ifMatch });
  }

  /** Set the folio's status (its column on the folder's board). */
  async setStatus(status, opts = {}) {
    const s = String(status || '').trim().toLowerCase();
    if (!FOLIO_STATUS_PATTERN.test(s)) throw new ValidationError(`“${status}” is not a status`);
    return this.updateManifest({ status: s }, opts);
  }

  /**
   * Relate this folio to another (by folio id): blocked_by, related, discovered_from, duplicate_of, supersedes.
   * `others` ([{ id, relationships }], e.g. the folios around it) is used to refuse blocked_by loops.
   */
  async relate(type, target, { actor = defaultActor, via = 'folio-lib', others = [] } = {}) {
    if (!RELATIONSHIP_TYPES.includes(type)) throw new ValidationError(`Relationship type must be one of ${RELATIONSHIP_TYPES.join(', ')}`);
    if (!isFolioId(target)) throw new ValidationError(`${target} is not a folio id`);
    const { manifest, etag } = await this.manifest();
    const rels = manifest.relationships || [];
    if (rels.some((r) => r.type === type && r.target === target)) return manifest;
    const cycle = wouldCycle([...others.filter((o) => o.id !== manifest.id), { id: manifest.id, relationships: rels }], manifest.id, type, target);
    if (cycle) throw new ValidationError(`That would create a loop: ${cycle.join(' → ')}`);
    return this.updateManifest({ relationships: [...rels, { type, target }] }, { ifMatch: etag, actor, via });
  }

  async unrelate(type, target, { actor = defaultActor, via = 'folio-lib' } = {}) {
    const { manifest, etag } = await this.manifest();
    const rels = (manifest.relationships || []).filter((r) => !(r.type === type && r.target === target));
    return this.updateManifest({ relationships: rels.length ? rels : undefined }, { ifMatch: etag, actor, via });
  }

  /** This folio's change history, oldest first. */
  /**
   * Changes to folio.json, oldest first. `limit` keeps only the newest that many (only those are read);
   * the result's `total` says how many there are in all.
   */
  async history({ limit } = {}) {
    // Names are the time of the change; several in the same instant are "<time> 2.json", "<time> 3.json".
    const seq = (f) => Number(/ (\d+)\.json$/.exec(f)?.[1] || 1);
    const all = (await this.fs.list('history/changes')).filter((f) => f.endsWith('.json')).sort((a, b) => a.replace(/( \d+)?\.json$/, '').localeCompare(b.replace(/( \d+)?\.json$/, '')) || seq(a) - seq(b));
    const files = limit > 0 ? all.slice(-limit) : all;
    const out = (await mapLimit(files, READS, (f) => this.fs.read(f))).filter(Boolean).map((c) => JSON.parse(c.text));
    Object.defineProperty(out, 'total', { value: all.length, enumerable: false });
    return out;
  }

  // ---- repositories (core part of the model) ----------------------------------

  async repositories() {
    const { manifest } = await this.manifest();
    return (manifest.repositories || []).map(describeRepository);
  }

  async addRepository(input, { actor } = {}) {
    const { manifest, etag } = await this.manifest();
    const repositories = addRepositoryTo(manifest.repositories || [], input, { now: this.now() });
    if (actor?.id && !repositories.at(-1).added_by) repositories.at(-1).added_by = actor.id;
    await this.updateManifest({ repositories }, { ifMatch: etag, actor });
    return repositories.at(-1);
  }

  /**
   * Record a release, pull request, issue, commit, branch or file of a listed repository (spec 3.2.1), in its
   * entry's `references`. Lists the repository first if needed. Returns { reference, added }.
   */
  async addRepositoryReference(repository, reference, { actor } = {}) {
    if (!(await this.repositories()).some((r) => repositoryKey(r) === repositoryKey(repository))) {
      const { ref, ...entry } = repository;
      await this.addRepository(entry, { actor });
    }
    const { manifest, etag } = await this.manifest();
    const list = manifest.repositories || [];
    const i = list.findIndex((r) => repositoryKey(r) === repositoryKey(repository));
    const refs = Array.isArray(list[i].references) ? list[i].references : [];
    const found = refs.find((r) => r.url === reference.url);
    if (found) return { reference: found, added: false };
    const entry = { ...reference, added_at: this.now(), ...(actor?.id ? { added_by: actor.id } : {}) };
    const repositories = list.map((r, j) => (j === i ? { ...r, references: [...refs, entry] } : r));
    await this.updateManifest({ repositories }, { ifMatch: etag, actor });
    return { reference: entry, added: true };
  }

  async removeRepository(input, { actor } = {}) {
    const { manifest, etag } = await this.manifest();
    const repositories = removeRepositoryFrom(manifest.repositories || [], input);
    if (repositories.length === (manifest.repositories || []).length) throw new NotFoundError('That repository entry');
    await this.updateManifest({ repositories }, { ifMatch: etag, actor });
  }

  // ---- folios inside this one ---------------------------------------------------

  /** A folio inside this one, by its folder (relative to this folio). */
  child(dir, opts = {}) {
    return new Folio(new SubFs(this.root, dir), { now: this.now, hold: this.hold, ...opts });
  }

  /**
   * The folios directly inside this one: [{ dir, id, title, status, type, tags, owner, target_date,
   * relationships, readiness, ... }]. Readiness is worked out against the other children (and `statusOf` for
   * folios elsewhere).
   */
  async children({ statusOf } = {}) {
    const dirs = this.nested.length ? this.nested : await nestedFolioDirs(this.root);
    const files = await mapLimit(dirs, READS, (d) => this.root.read(`${d}/folio.json`));
    const out = [];
    for (const [i, dir] of dirs.entries()) {
      try {
        if (files[i]) out.push({ dir, ...JSON.parse(files[i].text) });
      } catch {
        /* reported by its own validate() */
      }
    }
    const statuses = new Map(out.map((c) => [c.id, c.status]));
    const lookup = (id) => (statuses.has(id) ? statuses.get(id) : statusOf?.(id));
    return out.map((c) => ({ ...c, tags: normalizeTags(c.tags), readiness: readiness(c, lookup) }));
  }

  /**
   * Create a folio inside this one (a sub-folio): a request, a bug, a sub-project. It gets its own folder (named after the
   * title) with folio.json and README.md; `description` becomes the README. Returns { id, dir, manifest, folio }.
   */
  async createChild(input = {}, { actor = defaultActor, via = 'folio-lib', inDir = '' } = {}) {
    if (!input.title || !String(input.title).trim()) throw new ValidationError('A folio needs a title');
    const parent = inDir ? `${normalizePath(inDir)}/` : '';
    if (parent && !canHoldFolio(parent.slice(0, -1))) throw new ValidationError(`A folio cannot go inside ${parent}`);
    const base = childDirName(input.title);
    let dir = null;
    for (let n = 1; n < 500 && !dir; n++) {
      const name = `${parent}${n === 1 ? base : `${base}-${n}`}`;
      if (!(await this.root.list(name)).length) dir = name;
    }
    if (!dir) throw new ValidationError('Could not find a free folder name');
    const { title, summary, description, status = 'backlog', tags, ...fields } = input;
    const child = await Folio.init(new SubFs(this.root, dir), { title: scrubText(String(title)).text, summary, description: description ? scrubText(String(description)).text : undefined, status, tags, now: this.now, actor, via, ...fields });
    const { manifest } = await child.manifest();
    if (!this.nested.includes(dir) && !this.nested.some((d) => dir.startsWith(`${d}/`))) {
      this.nested.push(dir);
      this.fs = new ExcludingFs(this.root, this.nested);
    }
    if (this.onChild) await this.onChild({ id: manifest.id, dir, manifest });
    return { id: manifest.id, dir, manifest, folio: this.child(dir) };
  }

  // ---- the conversation (comms.js) --------------------------------------------

  /**
   * Comment on this folio. Comments are messages in comms/, with everything else said about the work. Without `to`
   * a comment is for the team; `to` sends it to the client (see post()).
   */
  async comment(text, { actor = defaultActor, via = 'folio-lib', kind = 'comment', attachments = [], to = null } = {}) {
    if (!text || !String(text).trim()) throw new ValidationError('A comment cannot be empty');
    return this.post(kind, text, { attachments, actor, via, to });
  }

  /**
   * Post a message to comms/: a comment, a status update, an agent's report or a captured chat. With no `to` it is
   * for the team: everyone with access and the folio's team CCs, never its client CCs (SPEC 5.7). `to` sends it to
   * the client: "client" (or true) for every client CC, or a list of CC keys or addresses, each a client CC on
   * this folio. The message records exactly who it went to.
   */
  async post(kind, text, { attachments = [], actor = defaultActor, via = 'folio-lib', at, to = null } = {}) {
    const keys = to === null || to === undefined || to === false ? null : await this.clientRecipients(to);
    return postMessage(this, { kind, text, attachments, actor, via, at, to: keys });
  }

  /** The keys of the client CCs `to` names: "client" or true for all of them, else keys or addresses. */
  async clientRecipients(to) {
    const { manifest } = await this.manifest();
    const clients = (manifest.cc || []).filter((c) => ccAudience(c) === 'client');
    if (to === true || to === 'client' || to === 'all') {
      if (!clients.length) throw new ValidationError('Nobody is on this folio’s client list to send to');
      return clients.map(ccKey);
    }
    const want = [].concat(to).filter((x) => x !== null && x !== undefined && x !== '');
    if (!want.length) throw new ValidationError('Choose at least one client contact to send to');
    return [
      ...new Set(
        want.map((w) => {
          const hit = clients[ccIndex(clients, w)];
          if (!hit) {
            const team = (manifest.cc || []).find((c) => ccKey(c) === w);
            throw new ValidationError(team ? `${team.name || team.address} is on the team list and hears everything already; only client contacts are chosen` : `${typeof w === 'string' ? w : w.address} is not a client contact on this folio`);
          }
          return ccKey(hit);
        })
      ),
    ];
  }

  /**
   * The conversation, oldest first (newest `limit`): messages and emails in comms/, each tagged with its thread
   * ("team" or "client", and "in" or "out" for the client's). Messages from the folio's CCs are marked `cc`. Pass
   * `cc` (folio.json's list) to save reading folio.json; `team(channel, address)` to count senders who are not
   * CC'd (staff domains) as the team.
   */
  async comms({ limit = 200, maxChars = 4000, cc, team = null, clean = false } = {}) {
    const list = cc ?? (await this.manifest().then(({ manifest }) => manifest.cc || [], () => []));
    return readComms(this, { limit, maxChars, cc: Array.isArray(list) ? list : [], team, clean, read: (items, fn) => mapLimit(items, READS, fn) });
  }

  /**
   * What a client may see of the conversation (SPEC 5.7.2): the client thread (messages sent to the client, and
   * what came from them), without anything kept from the client. Each item carries only what a client page needs;
   * the team's notes, agents' reports and who on the team is CC'd never appear. `clean` drops quoted history and
   * signatures from emails. A message sent to the client carries its author's name (`from`), never their address:
   * from `names` (a Map of lowercase email to name, e.g. the team's CC entries) when given, else the author's own
   * name, else one made from the address ("sam.okafor@..." -> "Sam Okafor"). An agent's message is signed by the
   * person it acted for.
   */
  async clientComms({ cc, team = null, clean = true, maxChars = 8000, names = null } = {}) {
    const items = await this.comms({ limit: 0, maxChars, cc, team, clean });
    return items
      .filter((m) => m.thread === 'client' && !m.hidden_from_client)
      .map((m) => ({ path: m.path, at: m.at, kind: m.kind === 'email' ? 'email' : 'message', direction: m.direction, from: m.direction === 'in' ? clientName(m) : staffName(m.author, names), to: m.direction === 'out' ? m.to || [] : null, subject: m.subject || null, text: m.text, ...(m.truncated ? { truncated: true } : {}), attachments: m.kind === 'email' ? [] : (m.attachments || []).map(String) }));
  }

  /** Keep a message or email in comms/ from the client, or show it again (SPEC 5.7.2). */
  hideFromClient(path, hidden = true, { actor = defaultActor } = {}) {
    return setHiddenFromClient(this, path, hidden, { actor });
  }

  /** The timing of the client thread (comms.js clientThread): who is waiting on whom, and since when; null if none. */
  async clientThread({ cc, team = null } = {}) {
    return clientThread(await this.comms({ limit: 0, maxChars: 1, cc, team }));
  }

  // ---- CC: people and channels kept informed (cc.js, spec 5.7) ------------------

  /** Who is CC'd on this folio: [{ channel, address, kind, name?, workspace?, key, integration_state }]. */
  async ccs() {
    const { manifest } = await this.manifest();
    return (manifest.cc || []).map((c) => ({ ...c, audience: ccAudience(c), key: ccKey(c), integration_state: 'reference_only' }));
  }

  /**
   * CC someone or a channel: an email address, "#slack-channel", "@slack-person", a phone number, or
   * { channel, address, name?, kind?, workspace? }. Already listed: its name is updated if a new one is given.
   * Returns { entry, added }.
   */
  async addCc(input, { actor = defaultActor, via = 'folio-lib', ...opts } = {}) {
    const entry = typeof input === 'string' ? parseCc(input, opts) : normalizeCc({ ...input, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v)) });
    const { manifest, etag } = await this.manifest();
    const list = Array.isArray(manifest.cc) ? manifest.cc : [];
    const key = ccKey(entry);
    const i = list.findIndex((c) => ccKey(c) === key);
    if (i >= 0) {
      // Already listed: a new name is taken, and a new audience when one was asked for (never the default).
      const audience = opts.audience || (typeof input === 'object' ? input.audience : null);
      const change = { ...(entry.name && entry.name !== list[i].name ? { name: entry.name } : {}), ...(audience && audience !== ccAudience(list[i]) ? { audience: entry.audience } : {}) };
      if (!Object.keys(change).length) return { entry: list[i], added: false };
      const cc = list.map((c, j) => (j === i ? { ...c, ...change } : c));
      await this.updateManifest({ cc }, { ifMatch: etag, actor, via });
      return { entry: cc[i], added: false };
    }
    if (list.length >= MAX_CC) throw new ValidationError(`A folio can have at most ${MAX_CC} CCs`);
    const added = { ...entry, added_at: this.now(), ...(actor?.id ? { added_by: actor.on_behalf_of || actor.id } : {}) };
    await this.updateManifest({ cc: [...list, added] }, { ifMatch: etag, actor, via });
    return { entry: added, added: true };
  }

  /** Move a CC between the team and client lists. `input`: a key, or what addCc takes. Returns { entry }. */
  async setCcAudience(input, audience, { actor = defaultActor, via = 'folio-lib' } = {}) {
    if (!CC_AUDIENCES.includes(audience)) throw new ValidationError(`A CC is on the ${CC_AUDIENCES.join(' or the ')} list`);
    const { manifest, etag } = await this.manifest();
    const list = Array.isArray(manifest.cc) ? manifest.cc : [];
    const i = ccIndex(list, input);
    if (i < 0) throw new NotFoundError('That CC');
    if (list[i].audience === audience) return { entry: list[i] };
    const cc = list.map((c, j) => (j === i ? { ...c, audience } : c));
    await this.updateManifest({ cc }, { ifMatch: etag, actor, via });
    return { entry: cc[i] };
  }

  /** Stop CC'ing someone: by key ("slack:#acme"), by what addCc takes, or by { channel, address }. */
  async removeCc(input, { actor = defaultActor, via = 'folio-lib' } = {}) {
    const { manifest, etag } = await this.manifest();
    const list = Array.isArray(manifest.cc) ? manifest.cc : [];
    let key = typeof input === 'string' && /^[a-z][a-z0-9_-]*(@[^:]+)?:/.test(input) && list.some((c) => ccKey(c) === input) ? input : null;
    if (!key) {
      const want = typeof input === 'string' ? parseCc(input) : normalizeCc(input);
      key = ccKey(findCc(list, want) || want);
    }
    const cc = list.filter((c) => ccKey(c) !== key);
    if (cc.length === list.length) throw new NotFoundError('That CC');
    await this.updateManifest({ cc: cc.length ? cc : undefined }, { ifMatch: etag, actor, via });
    return { removed: key };
  }

  /**
   * A message that came in over a channel from one of this folio's CCs (a Slack reply, an SMS): posted to comms/
   * and credited to that CC. `from`: { channel, address, workspace?, name? }. Only CCs may post this way; anyone
   * else is refused (NotFoundError). `ref` is the channel's id for the message, so a second delivery is ignored.
   * Returns { path, message, cc, duplicate? }.
   */
  async receive(from, text, { kind = 'comment', at, ref, attachments = [], via } = {}) {
    if (!['comment', 'chat', 'update'].includes(kind)) throw new ValidationError('A message from a CC is a comment, a chat or an update');
    const { manifest } = await this.manifest();
    const hit = findCc(manifest.cc || [], from);
    if (!hit) throw new NotFoundError('A CC with that address on this folio');
    const author = ccAuthor(hit, from.name && !hit.name ? { name: String(from.name).slice(0, 120) } : {});
    const r = await postMessage(this, { kind, text, attachments, actor: author, via: via || `channel/${hit.channel}`, at, ref: ref ? { channel: hit.channel, id: String(ref) } : null });
    return { ...r, cc: ccKey(hit) };
  }

  // ---- the checklist: Markdown checkboxes in README.md (checklist.js, spec 5.9) ----

  /** The folio's checklist: { items: [{ n, done, text }], done, total }. Empty when the README has none. */
  async checklist() {
    const cur = await this.fs.read(CHECKLIST_FILE);
    const items = parseChecklist(cur?.text || '').items.map(({ n, done, text }) => ({ n, done, text }));
    return { items, done: items.filter((i) => i.done).length, total: items.length, etag: cur?.etag ?? null };
  }

  /**
   * Change the checklist in one go: { add: [text], check: [ref], uncheck: [ref], remove: [ref], rename: [{ item, text }] },
   * where ref is an item's number, its text, or { n, expect } (expect: its text as last seen). Only README.md's
   * Checklist section changes; nothing is posted and status is untouched. A change made meanwhile by someone else
   * is merged (the edit is applied again to the new README) unless `ifMatch` was given. Returns { items, done, total }.
   */
  async editChecklist(changes = {}, { ifMatch } = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const cur = await this.fs.read(CHECKLIST_FILE);
      if (!cur) throw new NotFoundError(CHECKLIST_FILE);
      const { text, items, changed } = editChecklistText(cur.text, changes);
      const out = { items, done: items.filter((i) => i.done).length, total: items.length };
      if (!changed) return out;
      try {
        await this.fs.write(CHECKLIST_FILE, text, { ifMatch: ifMatch ?? cur.etag });
      } catch (e) {
        if (e instanceof ConflictError && !ifMatch && attempt < 2) continue;
        throw e;
      }
      if (this.onChecklist) await this.onChecklist(checklistCounts(text));
      return out;
    }
    throw new ConflictError(CHECKLIST_FILE);
  }

  /**
   * Turn a checklist item into a folio inside this one (when it needs an owner, a date, a conversation...): the
   * folio is created with the item's text as its title (and `fields`), and the item leaves the checklist.
   * Returns what createChild returns.
   */
  async checklistItemToFolio(ref, { actor = defaultActor, via = 'folio-lib', ...fields } = {}) {
    const cur = await this.fs.read(CHECKLIST_FILE);
    const item = findItem(parseChecklist(cur?.text || '').items, ref);
    const child = await this.createChild({ title: item.text, ...(item.done ? { status: 'completed', resolution: 'completed' } : {}), ...fields }, { actor, via });
    await this.editChecklist({ remove: [{ n: item.n, expect: item.text }] });
    return child;
  }

  // ---- tasks: well-defined work run elsewhere (tasks.js, spec 5.8) ----------------

  /**
   * The folio's tasks, oldest first: [{ id, dir, path, title, environment, kind, target, state, done, overdue,
   * run, complete_by, records, error, result, ... }]. `state` keeps only tasks in that state; `open` only those
   * not finished.
   */
  async tasks({ state, open = false } = {}) {
    const paths = (await this.fs.list(TASKS_DIR)).filter((p) => new RegExp(`^${TASKS_DIR}/[^/]+/${TASK_FILE.replace('.', '\\.')}$`).test(p));
    const files = await mapLimit(paths, READS, (p) => this.fs.read(p));
    const now = this.now();
    const out = [];
    for (const [i, p] of paths.entries()) {
      try {
        if (files[i]) out.push(taskSummary(JSON.parse(files[i].text), p.split('/')[1], now));
      } catch {
        /* reported by validate() */
      }
    }
    const want = state ? String(state).toUpperCase() : null;
    return out.filter((t) => (!want || t.state === want) && (!open || !t.done)).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.dir.localeCompare(b.dir));
  }

  /** Counts of the folio's tasks: { total, open, overdue, by_state: { RUNNING: n, ... } }. */
  async taskCounts() {
    const list = await this.tasks();
    const by_state = {};
    for (const t of list) by_state[t.state] = (by_state[t.state] || 0) + 1;
    return { total: list.length, open: list.filter((t) => !t.done).length, overdue: list.filter((t) => t.overdue).length, by_state };
  }

  /** The folder of a task, from its id, its folder name, or "tasks/<folder>". */
  async taskDir(ref) {
    const r = String(ref || '').trim().replace(/\/+$/, '');
    if (!r) throw new ValidationError('Which task? Give its id (tsk-…) or its folder');
    const name = r.startsWith(`${TASKS_DIR}/`) ? r.slice(TASKS_DIR.length + 1).split('/')[0] : r;
    if (!isTaskId(r) && (await this.fs.exists(`${TASKS_DIR}/${name}/${TASK_FILE}`))) return name;
    const hit = (await this.tasks()).find((t) => t.id === r);
    if (!hit) throw new NotFoundError(`Task ${r}`);
    return hit.dir;
  }

  /** One task: { dir, path, task, etag, output? } (output: the parsed output.json, with `output: true`). */
  async task(ref, { output = false } = {}) {
    const dir = await this.taskDir(ref);
    const cur = await this.fs.read(`${TASKS_DIR}/${dir}/${TASK_FILE}`);
    if (!cur) throw new NotFoundError(`Task ${ref}`);
    const task = JSON.parse(cur.text);
    const out = { dir, path: `${TASKS_DIR}/${dir}`, task, etag: cur.etag, done: isTerminalState(task.state), overdue: taskSummary(task, dir, this.now()).overdue };
    if (output && task.output) {
      const o = await this.fs.read(`${TASKS_DIR}/${dir}/${task.output}`);
      if (o) {
        try {
          out.output = JSON.parse(o.text);
        } catch {
          out.output = o.text;
        }
      }
    }
    return out;
  }

  /** One line for the conversation about a task. */
  taskMessage(t, dir, kind) {
    const where = `${environmentLabel(t.environment)} (${taskTarget(t)})`;
    if (kind === 'recorded') {
      const run = t.run?.flow_run_id ? `, flow run ${t.run.flow_run_id}` : '';
      const by = t.complete_by ? `; due to finish by ${t.complete_by.replace('T', ' ').slice(0, 16)} UTC` : '';
      return `Task “${t.title}” on ${where}: ${taskStateLabel(t.state).toLowerCase()}${run}${by}. Record: ${TASKS_DIR}/${dir}`;
    }
    const tail = t.state.type === 'COMPLETED' ? [t.records !== undefined ? `${t.records} ${t.records === 1 ? 'record' : 'records'}` : null, t.result].filter(Boolean).join('. ') : t.errors?.at(-1)?.message || t.result || '';
    return `Task “${t.title}” on ${where} ${taskStateLabel(t.state).toLowerCase()}${tail ? `: ${tail}` : ''}. Record: ${TASKS_DIR}/${dir}`;
  }

  /**
   * Record a task: a copy of what was (or will be) initiated on a platform, in tasks/<folder>/task.json.
   * `input`: { title?, summary?, description?, environment ("engine9/acme" or { platform, account_id, base_url? }),
   * path + method, or flow_id (+ tasks: [{ task_key, options }]), options?, tracking_code?, start_after?,
   * complete_by? or within_minutes?, definition_url?, run?: { flow_run_id, task_run_ids }, state?, output? }.
   * Posts a line to comms/ saying so (announce: false to skip). Returns { id, dir, path, task }.
   */
  async addTask(input = {}, { actor = defaultActor, via = 'folio-lib', announce = true } = {}) {
    const record = createTaskRecord(input, { now: this.now(), actor });
    const outputText = input.output !== undefined && input.output !== null ? taskOutputText(input.output) : null;
    if (outputText) record.output = TASK_OUTPUT_FILE;
    if (via) record.history[0].via = via;
    const base = taskDirName(record.title);
    let dir = null;
    for (let n = 1; n <= 500 && !dir; n++) {
      const name = n === 1 ? base : `${base}-${n}`;
      try {
        await this.fs.write(`${TASKS_DIR}/${name}/${TASK_FILE}`, json(record), { ifMatch: null, contentType: 'application/json' });
        dir = name;
      } catch (e) {
        if (!(e instanceof ConflictError) && e?.code !== 'conflict') throw e;
      }
    }
    if (!dir) throw new ValidationError('Could not find a free folder name in tasks/');
    if (outputText) await this.fs.write(`${TASKS_DIR}/${dir}/${TASK_OUTPUT_FILE}`, outputText, { contentType: 'application/json' });
    if (announce) await postMessage(this, { kind: actor?.type === 'agent' ? 'agent' : 'update', text: this.taskMessage(record, dir, 'recorded'), actor, via, task: `${TASKS_DIR}/${dir}` });
    return { id: record.id, dir, path: `${TASKS_DIR}/${dir}`, task: record };
  }

  /**
   * Bring a task's record up to date with the platform: state ({ type, name } or "COMPLETED"), run ids, start and
   * end time, records, errors, result (what came of it, in words), output (written to output.json), summary,
   * complete_by, options (only before it starts), note (kept in its history). A change of state is kept in the
   * task's history; reaching a final state (COMPLETED, FAILED, CANCELLED, CRASHED) also posts a line to comms/
   * (announce: false to skip). Returns { id, dir, path, task, changed }.
   */
  async updateTask(ref, patch = {}, { actor = defaultActor, via = 'folio-lib', ifMatch, announce = true } = {}) {
    const { dir, task, etag } = await this.task(ref);
    const { output, ...rest } = patch || {};
    const { next, changed, stateChanged } = applyTaskUpdate(task, rest, { now: this.now(), actor, via });
    let rec = next;
    if (output !== undefined) {
      const text = output === null ? null : taskOutputText(output);
      const file = `${TASKS_DIR}/${dir}/${TASK_OUTPUT_FILE}`;
      if (text) await this.fs.write(file, text, { contentType: 'application/json' });
      else if (task.output) await this.fs.remove(file);
      rec = { ...rec, updated_at: this.now() };
      if (text) rec.output = TASK_OUTPUT_FILE;
      else delete rec.output;
      changed.push('output');
    }
    if (rec !== task) await this.fs.write(`${TASKS_DIR}/${dir}/${TASK_FILE}`, json(rec), { ifMatch: ifMatch ?? etag, contentType: 'application/json' });
    if (announce && stateChanged && isTerminalState(rec.state)) await postMessage(this, { kind: actor?.type === 'agent' ? 'agent' : 'update', text: this.taskMessage(rec, dir, 'finished'), actor, via, task: `${TASKS_DIR}/${dir}` });
    return { id: rec.id, dir, path: `${TASKS_DIR}/${dir}`, task: rec, changed };
  }

  // ---- intake: drag and drop, paste, upload (intake.js) ----------------------------

  /**
   * Add something to the folio and let the folio decide where it belongs:
   * a repository URL is listed, an email is filed in comms/, other links are saved,
   * text becomes a note (or a message in comms/), files go to attachments/ (or a folder).
   * Returns one result per stored item: { kind, path?, summary }.
   */
  add(item, opts) {
    return addItem(this, item, opts);
  }

  /** What add() would do with an item, without doing it. */
  classify(item) {
    return classify(item);
  }

  /** What add() would do, where it would go, and what else the item could be saved as ({ as, choices }). */
  choices(item, { folder } = {}) {
    return intakeChoices(item, { folder });
  }

  // ---- importing from other tools (import.js) ----

  /** Every folio at any depth inside this one, with its folder: [{ dir, manifest }]. */
  async descendants() {
    const dirs = (await this.root.list()).filter((p) => p.endsWith('/folio.json')).map((p) => p.slice(0, -'/folio.json'.length));
    const files = await mapLimit(dirs, READS, (d) => this.root.read(`${d}/folio.json`));
    return dirs.map((dir, i) => {
      try {
        return { dir, manifest: JSON.parse(files[i]?.text || 'null') };
      } catch {
        return { dir, manifest: null };
      }
    }).filter((d) => d.manifest);
  }

  /**
   * Turn an export from another tool (Asana, Trello, or { folios: [...] }) into folios inside this one: each
   * item a folio (type from the export, if any), sub-items inside their parent's folio, dependencies as
   * blocked_by, comments in each folio's comms/. Folios already imported (same `external` source and id) are
   * skipped, so an export can be imported again. A record is kept in history/imports/.
   * Returns { format, label, created: [{ id, dir }], duplicates, path, summary }. With dryRun: { would_create, duplicates }.
   */
  async import(input, { format, name, actor = defaultActor, via = 'folio-lib', dryRun = false } = {}) {
    const doc = typeof input === 'string' || input instanceof Uint8Array ? parseJsonText(input) : input;
    if (doc === undefined) throw new ValidationError('That is not valid JSON');
    const { plans, ...found } = planImport(doc, { format });
    const existing = await this.descendants();
    const known = new Map(existing.filter((d) => d.manifest.external?.source && d.manifest.external?.id).map((d) => [`${d.manifest.external.source}:${d.manifest.external.id}`, { id: d.manifest.id, dir: d.dir }]));
    const placed = new Map(); // plan key -> { id, dir }
    const fresh = [];
    for (const p of plans) {
      const k = `${p.external.source}:${p.external.id}`;
      if (known.has(k)) placed.set(p.key, known.get(k));
      else if (!fresh.some((f) => f.key === p.key)) fresh.push(p);
    }
    const duplicates = plans.length - fresh.length;
    if (dryRun) return { ...found, would_create: fresh.length, duplicates };

    // Ids first, so dependencies can point at folios not created yet.
    const ids = new Map(fresh.map((p) => [p.key, newFolioId()]));
    const idOf = (key) => ids.get(key) || placed.get(key)?.id;
    const graph = existing.map((d) => ({ id: d.manifest.id, relationships: d.manifest.relationships || [] }));
    const rels = new Map();
    for (const p of fresh) {
      const me = idOf(p.key);
      const list = [];
      for (const b of p.blocked_by || []) {
        const target = idOf(b);
        if (!target || target === me || list.some((r) => r.target === target)) continue;
        const nodes = [...graph, ...[...rels.entries()].map(([id, r]) => ({ id, relationships: r })), { id: me, relationships: list }];
        if (!wouldCycle(nodes, me, 'blocked_by', target)) list.push({ type: 'blocked_by', target });
      }
      rels.set(me, list);
    }

    // Parents before children: a sub-item goes inside its parent's folder.
    const created = [];
    const failed = [];
    let pending = [...fresh];
    while (pending.length) {
      const next = [];
      for (const p of pending) {
        const parentKey = p.parent && plans.some((x) => x.key === p.parent) ? p.parent : null;
        if (parentKey && !placed.has(parentKey)) {
          if (pending.some((x) => x.key === parentKey) || failed.some((f) => f.key === parentKey)) {
            next.push(p);
            continue;
          }
        }
        const inDir = parentKey ? placed.get(parentKey).dir : '';
        try {
          const comments = (p.comments || []).slice(0, 200);
          const r = await this.createChild(
            {
              id: ids.get(p.key),
              title: String(p.title).slice(0, 300),
              description: p.description,
              ...(p.type ? { type: p.type } : {}),
              status: p.status || 'backlog',
              tags: p.tags,
              owner: p.owner ? String(p.owner).slice(0, 200) : undefined,
              outcome: p.outcome,
              target_date: p.target_date,
              resolution: p.resolution,
              links: p.links?.length ? p.links : undefined,
              relationships: rels.get(ids.get(p.key))?.length ? rels.get(ids.get(p.key)) : undefined,
              external: externalOf(p.external),
            },
            { actor, via, inDir }
          );
          for (const c of comments) {
            const by = [c.author, c.at ? String(c.at).slice(0, 10) : null].filter(Boolean).join(', ');
            const at = c.at && !Number.isNaN(Date.parse(c.at)) ? new Date(c.at).toISOString() : this.now();
            await postMessage(r.folio, { kind: 'comment', at, actor, via, text: `${by ? `(${found.label}, ${by}) ` : ''}${c.text}`, imported: { source: p.external.source, ...(c.author ? { author: c.author } : {}), ...(c.at ? { at: c.at } : {}) } });
          }
          placed.set(p.key, { id: r.id, dir: r.dir });
          created.push({ id: r.id, dir: r.dir, title: r.manifest.title });
        } catch (e) {
          failed.push({ key: p.key, title: p.title, problems: [e.message] });
        }
      }
      if (next.length === pending.length) {
        for (const p of next) failed.push({ key: p.key, title: p.title, problems: ['Its parent could not be imported'] });
        break;
      }
      pending = next;
    }

    const now = this.now();
    const stamp = now.replace(/[-:]/g, '').replace(/\.\d+/, '');
    const path = await createUnique(
      this.fs,
      'history/imports',
      `${stamp}-${found.format}.json`,
      json({ at: now, actor, via, format: found.format, ...(name ? { original_name: String(name) } : {}), ...(found.project ? { project: found.project } : {}), created: created.map((c) => ({ external: fresh.find((p) => placed.get(p.key)?.id === c.id)?.external.id, folio: c.id, dir: c.dir })), duplicates, ...(failed.length ? { failed } : {}) }),
      'application/json'
    );
    const parts = [`Imported ${created.length} ${created.length === 1 ? 'folio' : 'folios'} from ${found.label}${found.project ? ` (${found.project})` : ''}`];
    if (duplicates) parts.push(`${duplicates} already imported`);
    if (failed.length) parts.push(`${failed.length} could not be imported`);
    return { format: found.format, label: found.label, created, duplicates, ...(failed.length ? { failed } : {}), path, summary: parts.join('; ') };
  }

  /**
   * Change the type of a Markdown, HTML or text file (when detection guessed wrong): the file is renamed to the
   * format's extension, keeping its content; this folio's links follow. Returns { path, from, format }.
   */
  async setTextFormat(path, format, { actor = defaultActor, via = 'folio-lib' } = {}) {
    const from = normalizePath(path);
    const fmt = TEXT_FORMATS[format];
    if (!fmt) throw new ValidationError(`Unknown type ${format}. Use ${Object.keys(TEXT_FORMATS).join(', ')}.`);
    const current = textFormatOf(from);
    if (!current) throw new ValidationError(`${from} is not a Markdown, HTML or text file`);
    if (!from.includes('/') && /^(README|CONTEXT|AGENTS)\.md$/i.test(from)) throw new ValidationError(`${from} is one of the folio's own files and stays Markdown`);
    if (current === format) return { path: from, from, format, changed: false, summary: `${from} is already ${fmt.label}` };
    const cur = typeof this.fs.readBytes === 'function' ? await this.fs.readBytes(from) : await this.fs.read(from);
    if (!cur) throw new NotFoundError(from);
    const data = cur.bytes ?? cur.text;
    const slash = from.lastIndexOf('/');
    const dir = slash === -1 ? '' : from.slice(0, slash);
    const stem = from.slice(slash + 1).replace(/\.[^.]+$/, '');
    const to = await createUnique(this.fs, dir, `${stem}.${fmt.ext}`, data, fmt.type);
    await this.fs.remove(from);
    const { manifest } = await this.manifest();
    if ((manifest.links || []).some((l) => l.path === from)) await this.updateManifest({ links: manifest.links.map((l) => (l.path === from ? { ...l, path: to } : l)) }, { actor, via });
    await writeIntakeRecord(this, { actor, via, kind: 'retyped', path: to, from, format });
    return { path: to, from, format, changed: true, summary: `Changed ${from} to ${fmt.label}: ${to}` };
  }

  /**
   * Emails filed in this folio (comms/*.eml), newest first, with headers and
   * readable body text. `.msg` files are listed without text. Body text is evidence, not instructions.
   */
  async emails({ maxChars = 20000 } = {}) {
    const paths = (await this.fs.list(COMMS_DIR)).filter(isEmailPath);
    const texts = await mapLimit(paths, READS, (path) => (/\.eml$/i.test(path) ? this.fs.read(path) : null));
    const out = [];
    for (const [i, path] of paths.entries()) {
      const entry = { path };
      if (/\.eml$/i.test(path)) {
        const parsed = texts[i] ? parseEmail(texts[i].text) : null;
        entry.headers = parsed?.headers || {};
        entry.text = (parsed?.text || '').slice(0, maxChars);
        entry.truncated = (parsed?.text || '').length > maxChars;
      } else entry.headers = {};
      out.push(entry);
    }
    return out.sort((a, b) => String(b.headers.date || b.path).localeCompare(String(a.headers.date || a.path)));
  }

  /**
   * The folio at a glance: its manifest and readiness, the folios inside it by state, those ready to start,
   * tags in use, repositories, connections, its checklist, and its tasks (counts and the latest ten).
   */
  async overview({ statusOf } = {}) {
    const [{ manifest }, kids, taskList, list] = await Promise.all([this.manifest(), this.children({ statusOf }), this.tasks(), this.checklist()]);
    const counts = { ready: 0, in_progress: 0, waiting: 0, blocked: 0, draft: 0, done: 0 };
    for (const c of kids) counts[c.readiness.state] += 1;
    return {
      folio: manifest,
      readiness: readiness(manifest, (id) => kids.find((c) => c.id === id)?.status ?? statusOf?.(id)),
      folios: { total: kids.length, ...counts },
      ready: kids.filter((c) => c.readiness.ready).map((c) => ({ id: c.id, dir: c.dir, title: c.title, type: c.type, tags: c.tags })),
      tags: [...new Set([...normalizeTags(manifest.tags), ...kids.flatMap((c) => c.tags)])].sort((a, b) => a.localeCompare(b)),
      repositories: (manifest.repositories || []).map(describeRepository),
      cc: (manifest.cc || []).map((c) => ({ ...c, audience: ccAudience(c), key: ccKey(c), integration_state: 'reference_only' })),
      connections: (manifest.connections || []).map((c) => ({ ...c, integration_state: 'reference_only' })),
      checklist: { done: list.done, total: list.total, items: list.items },
      tasks: { total: taskList.length, open: taskList.filter((t) => !t.done).length, overdue: taskList.filter((t) => t.overdue).length, recent: taskList.slice(-10) },
    };
  }

  async search(query, { limit = 50 } = {}) {
    const q = String(query || '').toLowerCase();
    if (!q) return [];
    const hits = [];
    const paths = (await this.fs.list()).filter((path) => !path.startsWith('indexes/') && TEXT_EXT.test(path));
    const files = await mapLimit(paths, READS, (path) => this.fs.read(path));
    for (const [i, path] of paths.entries()) {
      const cur = files[i];
      if (!cur) continue;
      const lines = cur.text.split('\n');
      for (let j = 0; j < lines.length; j++) {
        if (lines[j].toLowerCase().includes(q)) {
          hits.push({ path, line: j + 1, text: lines[j].trim().slice(0, 240) });
          if (hits.length >= limit) return hits;
        }
      }
    }
    return hits;
  }

  validate() {
    return validateFolio(this.fs);
  }
}

/** Who a client-thread message came from, as a client page shows it: a name, else the address. */
function clientName(m) {
  if (m.kind === 'email') {
    const raw = m.forwarded_from || m.from || '';
    const name = /^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/.exec(raw)?.[1]?.trim();
    return name || String(raw).replace(/^.*<([^>]+)>.*$/, '$1') || 'Email';
  }
  return m.author?.name || m.author?.id || 'Client';
}

/** The name a client sees for someone on the team: never their address. */
export function staffName(author, names = null) {
  const id = String((author?.type === 'agent' ? author.on_behalf_of : author?.id) || '').toLowerCase();
  const fromMap = names && typeof names.get === 'function' ? names.get(id) : null;
  if (fromMap) return String(fromMap);
  if (author?.name && author.type !== 'agent') return String(author.name);
  const local = id.includes('@') ? id.split('@')[0] : id;
  const made = local.split(/[._+-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  return made || null;
}

export { normalizeTags };
