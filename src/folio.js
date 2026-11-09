import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { FOLIO_STATUS_PATTERN, createManifest, validateManifest } from './manifest.js';
import { addRepositoryTo, describeRepository, removeRepositoryFrom, repositoryKey } from './repositories.js';
import { buildGraph, findCycle, isTicketId, RELATIONSHIP_TYPES, readiness, validateTicket, wouldCycle } from './tickets.js';
import { validateFolio } from './validate.js';
import { addItem, classify, createUnique, intakeChoices, writeIntakeRecord } from './intake.js';
import { parseEmail } from './email.js';
import { scrubText } from './privacy.js';
import { ExcludingFs, nestedFolioDirs } from './nested.js';
import { normalizePath } from './fs.js';
import { TEXT_FORMATS, textFormatOf } from './text-format.js';
import { parseJsonText, planImport } from './import.js';
import { EMAIL_DIRS, isEmailPath, postMessage, readComms } from './comms.js';

const json = (o) => JSON.stringify(o, null, 2) + '\n';
const pad = (n) => String(n).padStart(6, '0');
const TEXT_EXT = /\.(md|json|txt|eml|csv|html|css|js)$/i;

const EDITABLE = ['title', 'type', 'status', 'priority', 'owner', 'outcome', 'target_date', 'tags', 'hold', 'waiting_on', 'resolution', 'resolution_note', 'links', 'participants'];

const defaultActor = { type: 'unknown' };

/** Where an imported ticket came from: { source, id, url?, ... } with string values, or null. */
function externalOf(x) {
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

const MAX_TICKET = (ids) => ids.reduce((m, id) => Math.max(m, Number(id.slice(3))), 0);

/** Tags as written: trimmed, unique, in order. Accepts an array or a comma-separated string; `labels` is the older name. */
export function normalizeTags(v) {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  const out = [];
  for (const t of list.map((x) => String(x).trim()).filter(Boolean)) if (!out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t.slice(0, 40));
  return out;
}
const ticketTagsFrom = (input) => normalizeTags(input.tags ?? input.labels);
/** A ticket's tags, reading the older `labels` field when `tags` is absent. */
export const ticketTags = (t) => normalizeTags(t?.tags ?? t?.labels);

export class Folio {
  /**
   * @param fs    a FolioFs (MemoryFs, NodeFs, or a hosted store)
   * @param hold  optional temporary storage for originals a folio must not keep (data files, logs, emails
   *              carrying card numbers): { put(bytes, { name, type, sha256, actor, via }) -> { store, key, expires_at } }.
   *              Without it only the summary or the text copy is kept (spec 8.4.1).
   */
  /**
   * @param nested  folders inside this folio that are folios of their own (see nested.js). Their files are hidden
   *                from this folio: not listed, searched or written. Folio.open(fs, { nested: 'detect' }) finds them.
   */
  /**
   * @param onManifest  called with the new manifest after this folio writes folio.json (hosts keep an index of
   *                    titles and statuses for fast listings).
   */
  constructor(fs, { now = () => new Date().toISOString(), hold = null, nested = [], onManifest = null } = {}) {
    this.onManifest = onManifest;
    this.nested = Array.isArray(nested) ? nested.map((d) => normalizePath(d)) : [];
    this.fs = this.nested.length ? new ExcludingFs(fs, this.nested) : fs;
    this.now = now;
    this.hold = hold;
  }

  /** Create a minimal folio: folio.json + README.md. Fails if one already exists here. */
  static async init(fs, { title, summary, status, id, tags, readme, now = () => new Date().toISOString() } = {}) {
    if (!title || !String(title).trim()) throw new ValidationError('A folio needs a title');
    const manifest = createManifest({ title: title.trim(), summary, status, id, now: now(), ...(tags ? { tags } : {}) });
    await fs.write('folio.json', json(manifest), { ifMatch: null });
    const body = readme || `# ${manifest.title}\n\n${summary || 'Describe why this folio exists and what a good outcome looks like.'}\n`;
    await fs.write('README.md', body, { ifMatch: null });
    return new Folio(fs, { now });
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

  async updateManifest(patch, { ifMatch } = {}) {
    const { manifest, etag } = await this.manifest();
    const next = { ...manifest, ...patch, updated_at: this.now() };
    const bad = validateManifest(next).filter((p) => p.level === 'error');
    if (bad.length) throw new ValidationError(bad);
    await this.fs.write('folio.json', json(next), { ifMatch: ifMatch ?? etag });
    if (this.onManifest) await this.onManifest(next);
    return next;
  }

  /** Set the folio's status (its column on the folder's board). Standard statuses: FOLIO_STATUSES; others are allowed. */
  async setStatus(status, { ifMatch } = {}) {
    const s = String(status || '').trim().toLowerCase();
    if (!FOLIO_STATUS_PATTERN.test(s)) throw new ValidationError(`“${status}” is not a status`);
    return this.updateManifest({ status: s }, { ifMatch });
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
    await this.updateManifest({ repositories }, { ifMatch: etag });
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
    await this.updateManifest({ repositories }, { ifMatch: etag });
    return { reference: entry, added: true };
  }

  async removeRepository(input) {
    const { manifest, etag } = await this.manifest();
    const repositories = removeRepositoryFrom(manifest.repositories || [], input);
    if (repositories.length === (manifest.repositories || []).length) throw new NotFoundError('That repository entry');
    await this.updateManifest({ repositories }, { ifMatch: etag });
  }

  // ---- tickets ----------------------------------------------------------------

  async ticketIds() {
    const files = await this.fs.list('tickets');
    const ids = new Set();
    for (const f of files) {
      const m = /^tickets\/(TK-\d+)\//.exec(f);
      if (m) ids.add(m[1]);
    }
    return [...ids].sort();
  }

  async getTicket(id) {
    const cur = await this.fs.read(`tickets/${id}/ticket.json`);
    if (!cur) throw new NotFoundError(`Ticket ${id}`);
    return { ticket: JSON.parse(cur.text), etag: cur.etag };
  }

  async listTickets() {
    const files = await mapLimit(await this.ticketIds(), READS, (id) => this.fs.read(`tickets/${id}/ticket.json`));
    const out = [];
    for (const cur of files) {
      if (!cur) continue;
      try {
        out.push(JSON.parse(cur.text));
      } catch {
        /* reported by validate() */
      }
    }
    return out;
  }

  async createTicket(input, { actor = defaultActor, via = 'folio-lib' } = {}) {
    const now = this.now();
    const base = {
      title: input.title && scrubText(String(input.title)).text,
      type: input.type || 'request',
      status: input.status || 'open',
      priority: input.priority || 'normal',
      ...(input.owner ? { owner: input.owner } : {}),
      ...(input.outcome ? { outcome: input.outcome } : {}),
      ...(input.target_date ? { target_date: input.target_date } : {}),
      ...(ticketTagsFrom(input).length ? { tags: ticketTagsFrom(input) } : {}),
      ...(input.links ? { links: input.links } : {}),
      ...(input.resolution ? { resolution: input.resolution } : {}),
      ...(externalOf(input.external) ? { external: externalOf(input.external) } : {}),
      relationships: input.relationships || [],
      revision: 1,
      created_at: now,
      updated_at: now,
    };
    const existing = await this.listTickets();
    const all = await this.ticketIds();
    let n = all.reduce((m, id) => Math.max(m, Number(id.slice(3))), 0);
    for (let attempt = 0; attempt < 8; attempt++) {
      n += 1;
      const id = `TK-${String(n).padStart(3, '0')}`;
      const ticket = { id, ...base };
      const problems = validateTicket(ticket).filter((p) => p.level === 'error');
      if (problems.length) throw new ValidationError(problems);
      for (const r of ticket.relationships) {
        if (!existing.some((t) => t.id === r.target)) throw new ValidationError(`Relationship target ${r.target} does not exist`);
      }
      const event = { ticket: id, revision: 1, at: now, actor, via, type: 'created' };
      try {
        await this.fs.write(`tickets/${id}/events/${pad(1)}.json`, json(event), { ifMatch: null });
      } catch (e) {
        if (e instanceof ConflictError) continue;
        throw e;
      }
      try {
        if (input.description) {
          const description = scrubText(input.description).text; // spec 3.7: no card numbers or credentials
          await this.fs.write(`tickets/${id}/description.md`, description.endsWith('\n') ? description : description + '\n');
        }
        await this.fs.write(`tickets/${id}/ticket.json`, json(ticket), { ifMatch: null });
      } catch (e) {
        await this.fs.remove(`tickets/${id}/events/${pad(1)}.json`);
        if (e instanceof ConflictError) continue;
        throw e;
      }
      return ticket;
    }
    throw new ConflictError('tickets', 'Could not allocate a ticket id; another writer is creating tickets');
  }

  /**
   * Commit one change. The create-only event file for the next revision is the
   * lock: two writers cannot both claim revision N+1. If the ticket write then
   * fails, the event is removed so a failed edit leaves nothing behind.
   */
  async _commit(ticket, etag, next, event, via, actor) {
    const rev = ticket.revision + 1;
    const updated = { ...next, revision: rev, updated_at: this.now() };
    const bad = validateTicket(updated).filter((p) => p.level === 'error');
    if (bad.length) throw new ValidationError(bad);
    const ev = { ticket: ticket.id, revision: rev, at: updated.updated_at, actor, via, ...event };
    const evPath = `tickets/${ticket.id}/events/${pad(rev)}.json`;
    await this.fs.write(evPath, json(ev), { ifMatch: null });
    try {
      await this.fs.write(`tickets/${ticket.id}/ticket.json`, json(updated), { ifMatch: etag });
    } catch (e) {
      await this.fs.remove(evPath);
      throw e;
    }
    return updated;
  }

  async updateTicket(id, patch, { actor = defaultActor, via = 'folio-lib', expectedRevision } = {}) {
    const { ticket, etag } = await this.getTicket(id);
    if (expectedRevision !== undefined && expectedRevision !== ticket.revision)
      throw new ConflictError(`tickets/${id}/ticket.json`, `${id} is at revision ${ticket.revision}, not ${expectedRevision}; reload and retry`);
    const next = { ...ticket };
    const changes = {};
    if ('tags' in patch) {
      patch = { ...patch, tags: normalizeTags(patch.tags) };
      if (!patch.tags.length) patch.tags = null;
      if (next.labels !== undefined) {
        changes.labels = { from: next.labels, to: null }; // tags replace the older labels field
        delete next.labels;
      }
    }
    for (const [k, v] of Object.entries(patch)) {
      if (!EDITABLE.includes(k)) throw new ValidationError(`${k} cannot be changed this way`);
      if (JSON.stringify(ticket[k]) === JSON.stringify(v)) continue;
      changes[k] = { from: ticket[k] ?? null, to: v ?? null };
      if (v === null || v === undefined) delete next[k];
      else next[k] = v;
    }
    if (Object.keys(changes).length === 0) return ticket;
    const type = changes.status ? 'status_changed' : 'updated';
    return this._commit(ticket, etag, next, { type, changes }, via, actor);
  }

  /**
   * Comment on a ticket (or, with no ticket id, on the folio). Comments are messages in comms/ (comms.js), with
   * everything else said about the work; they do not change the ticket, so they never conflict with an edit.
   * Returns { path, message }.
   */
  async comment(id, text, { actor = defaultActor, via = 'folio-lib', kind = 'comment' } = {}) {
    if (!text || !String(text).trim()) throw new ValidationError('A comment cannot be empty');
    if (id) await this.getTicket(id); // must exist
    return postMessage(this, { kind, text, ticket: id || null, actor, via });
  }

  /** Post a message to comms/: a comment, a status update, an agent's report or a captured chat. */
  post(kind, text, { ticket = null, attachments = [], actor = defaultActor, via = 'folio-lib' } = {}) {
    return postMessage(this, { kind, text, ticket, attachments, actor, via });
  }

  /**
   * Move a folio written before comms/ existed into the current layout: emails from sources/email/ to comms/,
   * their attachments and sources/uploads/ to attachments/. Ticket links follow; a record of every move is kept in
   * history/intake/ (kind "layout", `moves`: old path -> new path), so held originals stay findable. Comments kept
   * as ticket events stay there (they are history) and are still read by comms(). Safe to run twice.
   */
  async upgradeLayout({ actor = defaultActor, via = 'folio-lib' } = {}) {
    const plan = [];
    for (const p of await this.fs.list('sources/email')) {
      const rest = p.slice('sources/email/'.length);
      if (rest.startsWith('attachments/')) plan.push([p, `attachments/${rest.slice('attachments/'.length)}`]);
      else if (isEmailPath(p)) plan.push([p, `comms/${rest}`]);
    }
    for (const p of await this.fs.list('sources/uploads')) plan.push([p, `attachments/${p.slice('sources/uploads/'.length)}`]);
    if (!plan.length) return { moved: 0, moves: {}, summary: 'Already in the current layout' };
    const moves = {};
    await mapLimit(plan, 8, async ([from, to]) => {
      const cur = typeof this.fs.readBytes === 'function' ? await this.fs.readBytes(from) : await this.fs.read(from);
      if (!cur) return;
      const data = cur.bytes ?? cur.text;
      const slash = to.lastIndexOf('/');
      const dest = await createUnique(this.fs, to.slice(0, slash), to.slice(slash + 1), data, cur.contentType || undefined);
      await this.fs.remove(from);
      moves[from] = dest;
    });
    for (const t of await this.listTickets()) {
      if (!(t.links || []).some((l) => moves[l.path])) continue;
      await this.updateTicket(t.id, { links: t.links.map((l) => (moves[l.path] ? { ...l, path: moves[l.path] } : l)) }, { actor, via });
    }
    await writeIntakeRecord(this, { actor, via, kind: 'layout', moves });
    const n = Object.keys(moves).length;
    return { moved: n, moves, summary: `Moved ${n} ${n === 1 ? 'file' : 'files'}: emails to comms/, uploads and email attachments to attachments/` };
  }

  /** The conversation, oldest first (newest `limit`): comms/ messages and emails, and older ticket-event comments. */
  comms({ ticket = null, limit = 200, maxChars = 4000 } = {}) {
    return readComms(this, { ticket, limit, maxChars, read: (items, fn) => mapLimit(items, READS, fn) });
  }

  async relate(id, type, target, { actor = defaultActor, via = 'folio-lib' } = {}) {
    if (!RELATIONSHIP_TYPES.includes(type)) throw new ValidationError(`Unknown relationship ${type}`);
    if (!isTicketId(target)) throw new ValidationError(`${target} is not a ticket id`);
    const tickets = await this.listTickets();
    if (!tickets.some((t) => t.id === target)) throw new ValidationError(`${target} does not exist`);
    const cycle = wouldCycle(tickets, id, type, target);
    if (cycle) throw new ValidationError(`That would create a loop: ${cycle.join(' → ')}`);
    const { ticket, etag } = await this.getTicket(id);
    const rels = ticket.relationships || [];
    if (rels.some((r) => r.type === type && r.target === target)) return ticket;
    if (type === 'parent' && rels.some((r) => r.type === 'parent')) throw new ValidationError(`${id} already has a parent`);
    return this._commit(ticket, etag, { ...ticket, relationships: [...rels, { type, target }] }, { type: 'relationship_added', relationship: { type, target } }, via, actor);
  }

  async unrelate(id, type, target, { actor = defaultActor, via = 'folio-lib' } = {}) {
    const { ticket, etag } = await this.getTicket(id);
    const rels = (ticket.relationships || []).filter((r) => !(r.type === type && r.target === target));
    if (rels.length === (ticket.relationships || []).length) return ticket;
    return this._commit(ticket, etag, { ...ticket, relationships: rels }, { type: 'relationship_removed', relationship: { type, target } }, via, actor);
  }

  /** Add a link (to a file in this folio, or a URL) to a ticket's `links`, unless it is already there. */
  async linkTicket(id, link, { actor = defaultActor, via = 'folio-lib' } = {}) {
    if (!link || (typeof link.path !== 'string' && typeof link.url !== 'string')) throw new ValidationError('A link needs a path or a url');
    const { ticket, etag } = await this.getTicket(id);
    const links = ticket.links || [];
    if (links.some((l) => (link.path && l.path === link.path) || (link.url && l.url === link.url))) return ticket;
    return this._commit(ticket, etag, { ...ticket, links: [...links, link] }, { type: 'linked', link }, via, actor);
  }

  // ---- intake: putting dropped, uploaded or forwarded things in the right place ----

  /**
   * Add something to the folio and let the folio decide where it belongs (see intake.js):
   * a repository URL is listed, an email is filed in comms/, other links are saved,
   * text becomes a note (or a message in comms/), files go to attachments/ (or a ticket's attachments, or a folder).
   * Returns an array of results, each with a one-line `summary`.
   */
  add(item, opts) {
    return addItem(this, item, opts);
  }

  /** What add() would do with an item, without doing it. */
  classify(item) {
    return classify(item);
  }

  /** What add() would do, where it would go, and what else the item could be saved as ({ as, choices }). */
  choices(item, { ticket, folder } = {}) {
    return intakeChoices(item, { ticket, folder });
  }

  // ---- importing from other tools (import.js) ----

  /**
   * Turn an export from another tool (Asana, Trello, or { tickets: [...] }) into tickets. `input` is parsed JSON,
   * JSON text or bytes. Tickets already imported (same `external` source and id) are skipped, so an export can be
   * imported again after more work was added to it. Subtasks become child tickets, dependencies `blocked_by`,
   * comments the ticket's history. A record of what was imported is kept in history/imports/.
   * Returns { format, label, created: [ids], duplicates, path, summary }. With dryRun, only { would_create, duplicates }.
   */
  async import(input, { format, name, actor = defaultActor, via = 'folio-lib', dryRun = false } = {}) {
    const doc = typeof input === 'string' || input instanceof Uint8Array ? parseJsonText(input) : input;
    if (doc === undefined) throw new ValidationError('That is not valid JSON');
    const { plans, ...found } = planImport(doc, { format });
    const existing = await this.listTickets();
    const known = new Map(existing.filter((t) => t.external?.source && t.external?.id).map((t) => [`${t.external.source}:${t.external.id}`, t.id]));
    const ids = new Map(); // plan key -> ticket id
    const fresh = [];
    for (const p of plans) {
      const k = `${p.external.source}:${p.external.id}`;
      if (known.has(k)) ids.set(p.key, known.get(k));
      else if (!fresh.some((f) => f.key === p.key)) fresh.push(p);
    }
    const duplicates = plans.length - fresh.length;
    if (dryRun) return { ...found, would_create: fresh.length, duplicates };

    // Claim ids first (the create-only first event is the lock, as in createTicket), so relationships can point anywhere.
    const now = this.now();
    let n = MAX_TICKET(await this.ticketIds());
    const claimed = [];
    for (const p of fresh) {
      for (let attempt = 0; ; attempt++) {
        if (attempt > 50) throw new ConflictError('tickets', 'Could not allocate ticket ids; another writer is creating tickets');
        const id = `TK-${String(++n).padStart(3, '0')}`;
        const event = { ticket: id, revision: 1, at: now, actor, via, type: 'created', imported: { source: p.external.source, id: p.external.id } };
        try {
          await this.fs.write(`tickets/${id}/events/${pad(1)}.json`, json(event), { ifMatch: null });
        } catch (e) {
          if (e instanceof ConflictError) continue;
          throw e;
        }
        ids.set(p.key, id);
        claimed.push({ p, id });
        break;
      }
    }

    // Relationships: parents first, then blockers that would not make a loop.
    const tickets = new Map(existing.map((t) => [t.id, t]));
    for (const { p, id } of claimed) tickets.set(id, { id, relationships: [] });
    for (const { p, id } of claimed) {
      const parent = p.parent ? ids.get(p.parent) : null;
      if (parent && parent !== id) {
        const trial = { ...tickets.get(id), relationships: [{ type: 'parent', target: parent }] };
        if (!findCycle([...tickets.values()].map((t) => (t.id === id ? trial : t)), 'parent')) tickets.set(id, trial);
      }
    }
    for (const { p, id } of claimed) {
      for (const b of p.blocked_by || []) {
        const target = ids.get(b);
        if (!target || target === id) continue;
        const cur = tickets.get(id);
        if (cur.relationships.some((r) => r.type === 'blocked_by' && r.target === target)) continue;
        if (!wouldCycle([...tickets.values()], id, 'blocked_by', target)) tickets.set(id, { ...cur, relationships: [...cur.relationships, { type: 'blocked_by', target }] });
      }
    }

    const created = [];
    const failed = [];
    for (const { p, id } of claimed) {
      const comments = (p.comments || []).slice(0, 200);
      const tags = normalizeTags(p.tags);
      const ticket = {
        id,
        title: scrubText(String(p.title)).text.slice(0, 300),
        type: p.type || 'request',
        status: p.status || 'open',
        priority: p.priority || 'normal',
        ...(p.owner ? { owner: String(p.owner).slice(0, 200) } : {}),
        ...(p.outcome ? { outcome: scrubText(String(p.outcome)).text } : {}),
        ...(p.target_date ? { target_date: p.target_date } : {}),
        ...(tags.length ? { tags } : {}),
        ...(p.links?.length ? { links: p.links } : {}),
        ...(p.resolution ? { resolution: p.resolution } : {}),
        external: externalOf(p.external),
        relationships: tickets.get(id).relationships,
        revision: 1,
        created_at: now,
        updated_at: now,
      };
      const problems = validateTicket(ticket).filter((x) => x.level === 'error');
      if (problems.length) {
        await this.fs.remove(`tickets/${id}/events/${pad(1)}.json`);
        failed.push({ key: p.key, title: p.title, problems: problems.map((x) => x.message) });
        continue;
      }
      for (const c of comments) {
        const by = [c.author, c.at ? String(c.at).slice(0, 10) : null].filter(Boolean).join(', ');
        const at = c.at && !Number.isNaN(Date.parse(c.at)) ? new Date(c.at).toISOString() : now;
        await postMessage(this, { kind: 'comment', ticket: id, at, actor, via, text: `${by ? `(${found.label}, ${by}) ` : ''}${c.text}`, imported: { source: p.external.source, ...(c.author ? { author: c.author } : {}), ...(c.at ? { at: c.at } : {}) } });
      }
      if (p.description && String(p.description).trim()) {
        const d = scrubText(String(p.description)).text;
        await this.fs.write(`tickets/${id}/description.md`, d.endsWith('\n') ? d : d + '\n');
      }
      await this.fs.write(`tickets/${id}/ticket.json`, json(ticket), { ifMatch: null });
      created.push(id);
    }

    const stamp = now.replace(/[-:]/g, '').replace(/\.\d+/, '');
    const path = await createUnique(
      this.fs,
      'history/imports',
      `${stamp}-${found.format}.json`,
      json({ at: now, actor, via, format: found.format, ...(name ? { original_name: String(name) } : {}), ...(found.project ? { project: found.project } : {}), created: claimed.filter((c) => created.includes(c.id)).map((c) => ({ external: c.p.external.id, ticket: c.id })), duplicates, ...(failed.length ? { failed } : {}) }),
      'application/json'
    );
    const parts = [`Imported ${created.length} ${created.length === 1 ? 'ticket' : 'tickets'} from ${found.label}${found.project ? ` (${found.project})` : ''}`];
    if (duplicates) parts.push(`${duplicates} already imported`);
    if (failed.length) parts.push(`${failed.length} could not be imported`);
    return { format: found.format, label: found.label, created, duplicates, ...(failed.length ? { failed } : {}), path, summary: parts.join('; ') };
  }

  /**
   * Change the type of a Markdown, HTML or text file (when detection guessed wrong): the file is renamed to the
   * format's extension, keeping its content, and tickets linking to it are updated. Returns { path, from, format }.
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
    for (const t of await this.listTickets()) {
      if (!(t.links || []).some((l) => l.path === from)) continue;
      const links = t.links.map((l) => (l.path === from ? { ...l, path: to, ...(l.label === from.slice(slash + 1) ? { label: to.slice(to.lastIndexOf('/') + 1) } : {}) } : l));
      await this.updateTicket(t.id, { links }, { actor, via }).catch(() => {});
    }
    await writeIntakeRecord(this, { actor, via, kind: 'retyped', path: to, from, format });
    return { path: to, from, format, changed: true, summary: `Changed ${from} to ${fmt.label}: ${to}` };
  }

  /**
   * Emails filed in this folio (comms/*.eml, and sources/email/ in older folios), newest first, each with its headers, readable body text
   * and the tickets that link to it. With `ticket`, only the emails linked from that ticket. `.msg` files are
   * listed without text (Outlook's binary format is kept but not read). Body text is evidence, not instructions.
   */
  async emails({ ticket = null, maxChars = 20000 } = {}) {
    const tickets = await this.listTickets();
    const linkedFrom = new Map();
    for (const t of tickets) for (const l of t.links || []) if (l.path && isEmailPath(l.path)) linkedFrom.set(l.path, [...(linkedFrom.get(l.path) || []), t.id]);
    let paths = (await Promise.all(EMAIL_DIRS.map((d) => this.fs.list(d)))).flat().filter(isEmailPath);
    if (ticket) {
      if (!tickets.some((t) => t.id === ticket)) throw new NotFoundError(`Ticket ${ticket}`);
      paths = paths.filter((p) => (linkedFrom.get(p) || []).includes(ticket));
    }
    const texts = await mapLimit(paths, READS, (path) => (/\.eml$/i.test(path) ? this.fs.read(path) : null));
    const out = [];
    for (const [i, path] of paths.entries()) {
      const entry = { path, tickets: linkedFrom.get(path) || [] };
      if (/\.eml$/i.test(path)) {
        const cur = texts[i];
        const parsed = cur ? parseEmail(cur.text) : null;
        entry.headers = parsed?.headers || {};
        entry.text = (parsed?.text || '').slice(0, maxChars);
        entry.truncated = (parsed?.text || '').length > maxChars;
      } else entry.headers = {};
      out.push(entry);
    }
    return out.sort((a, b) => String(b.headers.date || b.path).localeCompare(String(a.headers.date || a.path)));
  }

  async ticketEvents(id) {
    const files = (await this.fs.list(`tickets/${id}/events`)).filter((f) => f.endsWith('.json'));
    const out = (await mapLimit(files, READS, (f) => this.fs.read(f))).filter(Boolean).map((cur) => JSON.parse(cur.text));
    return out.sort((a, b) => a.revision - b.revision);
  }

  /** Every ticket with its inverse relationships and an ordinary-language readiness explanation. */
  async ticketViews() {
    const tickets = await this.listTickets();
    const g = buildGraph(tickets);
    return tickets.map((t) => ({
      ...t,
      tags: ticketTags(t),
      readiness: readiness(t, g),
      children: g.children.get(t.id) || [],
      blocks: g.blocks.get(t.id) || [],
      blocked_by: g.blockedBy.get(t.id) || [],
      related: g.related.get(t.id) || [],
    }));
  }

  async readyTickets() {
    return (await this.ticketViews()).filter((t) => t.readiness.ready);
  }

  async overview() {
    const [{ manifest }, views] = await Promise.all([this.manifest(), this.ticketViews()]);
    const counts = { ready: 0, in_progress: 0, waiting: 0, blocked: 0, done: 0 };
    for (const t of views) counts[t.readiness.state] += 1;
    return {
      folio: manifest,
      tickets: { total: views.length, ...counts },
      ready: views.filter((t) => t.readiness.ready).map((t) => ({ id: t.id, title: t.title, priority: t.priority, tags: t.tags })),
      tags: [...new Set(views.flatMap((t) => t.tags))].sort((a, b) => a.localeCompare(b)),
      repositories: (manifest.repositories || []).map(describeRepository),
      connections: (manifest.connections || []).map((c) => ({ ...c, integration_state: 'reference_only' })),
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
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(q)) {
          hits.push({ path, line: i + 1, text: lines[i].trim().slice(0, 240) });
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
