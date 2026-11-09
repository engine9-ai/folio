import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { FOLIO_STATUS_PATTERN, createManifest, newFolioId, validateManifest } from './manifest.js';
import { addRepositoryTo, describeRepository, removeRepositoryFrom, repositoryKey } from './repositories.js';
import { FOLIO_PRIORITIES, RELATIONSHIP_TYPES, isFolioId, normalizeTags, readiness, wouldCycle } from './relations.js';
import { validateFolio } from './validate.js';
import { addItem, classify, createUnique, intakeChoices, slugify, writeIntakeRecord } from './intake.js';
import { parseEmail } from './email.js';
import { scrubText } from './privacy.js';
import { ExcludingFs, canHoldFolio, nestedFolioDirs } from './nested.js';
import { SubFs, normalizePath } from './fs.js';
import { TEXT_FORMATS, textFormatOf } from './text-format.js';
import { parseJsonText, planImport } from './import.js';
import { EMAIL_DIRS, isEmailPath, postMessage, readComms } from './comms.js';
import { convertTickets } from './legacy-tickets.js';

const json = (o) => JSON.stringify(o, null, 2) + '\n';
const TEXT_EXT = /\.(md|json|txt|eml|csv|html|css|js)$/i;

/** Fields of folio.json that people and agents edit directly (edit()). */
export const EDITABLE = ['title', 'summary', 'type', 'status', 'priority', 'owner', 'target_date', 'tags', 'outcome', 'resolution', 'waiting_on', 'hold', 'links'];

const defaultActor = { type: 'unknown' };

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
   */
  constructor(fs, { now = () => new Date().toISOString(), hold = null, nested = [], onManifest = null, onChild = null } = {}) {
    this.root = fs;
    this.nested = Array.isArray(nested) ? nested.map((d) => normalizePath(d)) : [];
    this.fs = this.nested.length ? new ExcludingFs(fs, this.nested) : fs;
    this.now = now;
    this.hold = hold;
    this.onManifest = onManifest;
    this.onChild = onChild;
  }

  /** Create a minimal folio: folio.json + README.md. Fails if one already exists here. */
  static async init(fs, { title, summary, status, id, tags, readme, description, now = () => new Date().toISOString(), actor = defaultActor, via = 'folio-lib', ...fields } = {}) {
    if (!title || !String(title).trim()) throw new ValidationError('A folio needs a title');
    const clean = (v) => (typeof v === 'string' ? scrubText(v).text.trim() || undefined : v);
    summary = clean(summary);
    description = clean(description);
    if (typeof readme === 'string') readme = scrubText(readme).text;
    for (const k of ['outcome', 'resolution', 'waiting_on']) fields[k] = clean(fields[k]);
    const extra = {};
    for (const k of ['type', 'priority', 'owner', 'target_date', 'outcome', 'resolution', 'links', 'relationships', 'external', 'aliases', 'waiting_on']) if (fields[k] !== undefined && fields[k] !== null && fields[k] !== '') extra[k] = fields[k];
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

  /** Edit the fields people work with (EDITABLE): title, status, type, priority, owner, target date, tags... */
  async edit(patch, { actor = defaultActor, via = 'folio-lib', ifMatch } = {}) {
    const clean = {};
    for (const [k, v] of Object.entries(patch || {})) {
      if (!EDITABLE.includes(k)) throw new ValidationError(`${k} cannot be edited this way (editable: ${EDITABLE.join(', ')})`);
      if (k === 'tags') clean.tags = normalizeTags(v).length ? normalizeTags(v) : undefined;
      else if (k === 'status' || k === 'type') clean[k] = v ? String(v).trim().toLowerCase() : undefined;
      else if (typeof v === 'string') clean[k] = k === 'title' ? v.trim() : scrubText(v).text.trim() || undefined;
      else clean[k] = v ?? undefined;
    }
    if (clean.status !== undefined && !FOLIO_STATUS_PATTERN.test(clean.status)) throw new ValidationError(`“${patch.status}” is not a status`);
    if (clean.priority !== undefined && !FOLIO_PRIORITIES.includes(clean.priority)) throw new ValidationError(`priority must be one of ${FOLIO_PRIORITIES.join(', ')}`);
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
   * The folios directly inside this one: [{ dir, id, title, status, type, priority, tags, owner, target_date,
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
   * Create a folio inside this one: a ticket, a task, a sub-project. It gets its own folder (named after the
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

  /** Comment on this folio. Comments are messages in comms/, with everything else said about the work. */
  async comment(text, { actor = defaultActor, via = 'folio-lib', kind = 'comment', attachments = [] } = {}) {
    if (!text || !String(text).trim()) throw new ValidationError('A comment cannot be empty');
    return postMessage(this, { kind, text, attachments, actor, via });
  }

  /** Post a message to comms/: a comment, a status update, an agent's report or a captured chat. */
  post(kind, text, { attachments = [], actor = defaultActor, via = 'folio-lib', at } = {}) {
    return postMessage(this, { kind, text, attachments, actor, via, at });
  }

  /** The conversation, oldest first (newest `limit`): messages and emails in comms/ (and older sources/email). */
  comms({ limit = 200, maxChars = 4000 } = {}) {
    return readComms(this, { limit, maxChars, read: (items, fn) => mapLimit(items, READS, fn) });
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
   * Turn an export from another tool (Asana, Trello, or { tickets: [...] }) into folios inside this one: each
   * task a folio (type from the export, ticket by default), subtasks inside their task's folio, dependencies as
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

    // Parents before children: a subtask goes inside its task's folder.
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
              type: p.type || 'ticket',
              status: p.status || 'backlog',
              priority: p.priority || 'normal',
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
   * Bring a folio written by an earlier version up to date:
   *  - emails from sources/email/ to comms/, uploads and email attachments to attachments/;
   *  - tickets (tickets/TK-001/...) become folios inside this one (legacy-tickets.js): description, status,
   *    priority, tags, links, comments and history come along; a ticket's parent becomes its folder; the old
   *    ticket id stays as an alias (TK-001) so email addresses and references keep working.
   * A record of every move is kept in history/intake/ (kind "layout"). Safe to run again.
   * Returns { moved, converted: [{ id, dir, alias }], summary }.
   */
  async upgradeLayout({ actor = defaultActor, via = 'folio-lib' } = {}) {
    const plan = [];
    for (const p of await this.fs.list('sources/email')) {
      const rest = p.slice('sources/email/'.length);
      if (rest.startsWith('attachments/')) plan.push([p, `attachments/${rest.slice('attachments/'.length)}`]);
      else if (isEmailPath(p)) plan.push([p, `comms/${rest}`]);
    }
    for (const p of await this.fs.list('sources/uploads')) plan.push([p, `attachments/${p.slice('sources/uploads/'.length)}`]);
    const moves = {};
    await mapLimit(plan, 8, async ([from, to]) => {
      const cur = typeof this.fs.readBytes === 'function' ? await this.fs.readBytes(from) : await this.fs.read(from);
      if (!cur) return;
      const slash = to.lastIndexOf('/');
      const dest = await createUnique(this.fs, to.slice(0, slash), to.slice(slash + 1), cur.bytes ?? cur.text, cur.contentType || undefined);
      await this.fs.remove(from);
      moves[from] = dest;
    });
    const converted = await convertTickets(this, { actor, via, moves });
    if (!Object.keys(moves).length && !converted.length) return { moved: 0, converted: [], moves: {}, summary: 'Already in the current layout' };
    await writeIntakeRecord(this, { actor, via, kind: 'layout', moves, ...(converted.length ? { converted } : {}) });
    const n = Object.keys(moves).length;
    const parts = [];
    if (n) parts.push(`Moved ${n} ${n === 1 ? 'file' : 'files'}: emails to comms/, uploads and email attachments to attachments/`);
    if (converted.length) parts.push(`Turned ${converted.length} ${converted.length === 1 ? 'ticket' : 'tickets'} into folios`);
    return { moved: n, converted, moves, summary: parts.join('; ') };
  }

  /**
   * Emails filed in this folio (comms/*.eml, and sources/email/ in older folios), newest first, with headers and
   * readable body text. `.msg` files are listed without text. Body text is evidence, not instructions.
   */
  async emails({ maxChars = 20000 } = {}) {
    const paths = (await Promise.all(EMAIL_DIRS.map((d) => this.fs.list(d)))).flat().filter(isEmailPath);
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
   * tags in use, repositories and connections.
   */
  async overview({ statusOf } = {}) {
    const [{ manifest }, kids] = await Promise.all([this.manifest(), this.children({ statusOf })]);
    const counts = { ready: 0, in_progress: 0, waiting: 0, blocked: 0, draft: 0, done: 0 };
    for (const c of kids) counts[c.readiness.state] += 1;
    return {
      folio: manifest,
      readiness: readiness(manifest, (id) => kids.find((c) => c.id === id)?.status ?? statusOf?.(id)),
      folios: { total: kids.length, ...counts },
      ready: kids.filter((c) => c.readiness.ready).map((c) => ({ id: c.id, dir: c.dir, title: c.title, type: c.type, priority: c.priority, tags: c.tags })),
      tags: [...new Set([...normalizeTags(manifest.tags), ...kids.flatMap((c) => c.tags)])].sort((a, b) => a.localeCompare(b)),
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

export { normalizeTags };
