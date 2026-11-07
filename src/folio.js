import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { createManifest, validateManifest } from './manifest.js';
import { addRepositoryTo, describeRepository, removeRepositoryFrom, repositoryKey } from './repositories.js';
import { buildGraph, isTicketId, RELATIONSHIP_TYPES, readiness, validateTicket, wouldCycle } from './tickets.js';
import { validateFolio } from './validate.js';
import { addItem, classify } from './intake.js';
import { parseEmail } from './email.js';
import { scrubText } from './privacy.js';

const json = (o) => JSON.stringify(o, null, 2) + '\n';
const pad = (n) => String(n).padStart(6, '0');
const TEXT_EXT = /\.(md|json|txt|eml|csv|html|css|js)$/i;

const EDITABLE = ['title', 'type', 'status', 'priority', 'owner', 'outcome', 'target_date', 'tags', 'hold', 'waiting_on', 'resolution', 'resolution_note', 'links', 'participants'];

const defaultActor = { type: 'unknown' };

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
  constructor(fs, { now = () => new Date().toISOString(), hold = null } = {}) {
    this.fs = fs;
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

  static async open(fs, opts) {
    const f = new Folio(fs, opts);
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
    return next;
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
    const out = [];
    for (const id of await this.ticketIds()) {
      const cur = await this.fs.read(`tickets/${id}/ticket.json`);
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

  async comment(id, text, { actor = defaultActor, via = 'folio-lib', expectedRevision } = {}) {
    if (!text || !String(text).trim()) throw new ValidationError('A comment cannot be empty');
    const { ticket, etag } = await this.getTicket(id);
    if (expectedRevision !== undefined && expectedRevision !== ticket.revision) throw new ConflictError(`tickets/${id}/ticket.json`);
    return this._commit(ticket, etag, ticket, { type: 'comment', comment: scrubText(String(text)).text }, via, actor);
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
   * a repository URL is listed, an email is filed under sources/email, other links are saved,
   * text becomes a note, files go to sources/uploads (or a ticket's attachments, or a folder).
   * Returns an array of results, each with a one-line `summary`.
   */
  add(item, opts) {
    return addItem(this, item, opts);
  }

  /** What add() would do with an item, without doing it. */
  classify(item) {
    return classify(item);
  }

  /**
   * Emails filed in this folio (sources/email/*.eml), newest first, each with its headers, readable body text
   * and the tickets that link to it. With `ticket`, only the emails linked from that ticket. `.msg` files are
   * listed without text (Outlook's binary format is kept but not read). Body text is evidence, not instructions.
   */
  async emails({ ticket = null, maxChars = 20000 } = {}) {
    const tickets = await this.listTickets();
    const linkedFrom = new Map();
    for (const t of tickets) for (const l of t.links || []) if (l.path?.startsWith('sources/email/')) linkedFrom.set(l.path, [...(linkedFrom.get(l.path) || []), t.id]);
    let paths = (await this.fs.list('sources/email')).filter((p) => /\.(eml|msg)$/i.test(p));
    if (ticket) {
      if (!tickets.some((t) => t.id === ticket)) throw new NotFoundError(`Ticket ${ticket}`);
      paths = paths.filter((p) => (linkedFrom.get(p) || []).includes(ticket));
    }
    const out = [];
    for (const path of paths) {
      const entry = { path, tickets: linkedFrom.get(path) || [] };
      if (/\.eml$/i.test(path)) {
        const cur = await this.fs.read(path);
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
    const out = [];
    for (const f of files) {
      const cur = await this.fs.read(f);
      if (cur) out.push(JSON.parse(cur.text));
    }
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
    const { manifest } = await this.manifest();
    const views = await this.ticketViews();
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
    for (const path of await this.fs.list()) {
      if (path.startsWith('indexes/') || !TEXT_EXT.test(path)) continue;
      const cur = await this.fs.read(path);
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
