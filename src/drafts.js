import { NotFoundError, ValidationError } from './errors.js';
import { COMMS_DIR, messageName } from './comms.js';
import { scrubText } from './privacy.js';

/**
 * Drafts of client messages (SPEC 5.7.3). A message to the client is written as a draft first, and a person sends
 * it: agents draft, people approve. A draft is a file in comms/drafts/ (`<date>-<time>-<slug>.draft.json`):
 *
 *   { "kind": "draft", "at", "author", "via", "text", "to": "client" | [cc keys], "attachments"?,
 *     "updated_at"?, "updated_by"? }
 *
 * Drafts are seen by the team (pages show them as "Draft awaiting approval"), never by the client, and are not part
 * of the conversation: readComms lists only comms/ itself. Sending one posts it to comms/ as a message to the
 * client, recording who drafted it (`drafted: { by, at }`) and who sent it (the author), and removes the draft.
 */

export const DRAFTS_DIR = `${COMMS_DIR}/drafts`;
const DRAFT_FILE = /^comms\/drafts\/[^/]+\.draft\.json$/;
export const MAX_DRAFT = 20_000;

export const isDraftPath = (p) => DRAFT_FILE.test(String(p || ''));

const json = (o) => JSON.stringify(o, null, 2) + '\n';

function cleanTo(to) {
  if (to === undefined || to === null || to === true || to === 'client' || to === 'all') return 'client';
  const list = [].concat(to).map((x) => String(x || '').trim()).filter(Boolean);
  if (!list.length) return 'client';
  return [...new Set(list)];
}

function checkText(text) {
  const t = String(text ?? '');
  if (!t.trim()) throw new ValidationError('A draft cannot be empty');
  if (t.length > MAX_DRAFT) throw new ValidationError(`A draft is at most ${MAX_DRAFT} characters`);
  return scrubText(t);
}

/** Write a new draft. `to`: "client" (every client CC when it is sent) or CC keys/addresses. Returns { path, draft, removed? }. */
export async function writeDraft(folio, { text, to = 'client', attachments = [], actor, via = 'folio-lib' }) {
  const { text: clean, removed, total } = checkText(text);
  const at = folio.now();
  const draft = { kind: 'draft', at, author: actor || { type: 'unknown' }, via, text: clean, to: cleanTo(to), ...(attachments.length ? { attachments: attachments.map(String) } : {}) };
  const name = messageName(at, clean, 'draft');
  const stem = name.slice(0, -'.draft.json'.length);
  for (let n = 1; n <= 200; n++) {
    const path = `${DRAFTS_DIR}/${n === 1 ? name : `${stem}-${n}.draft.json`}`;
    try {
      await folio.fs.write(path, json(draft), { ifMatch: null, contentType: 'application/json' });
      return { path, draft, ...(total ? { removed } : {}) };
    } catch (e) {
      if (e?.code !== 'conflict') throw e;
    }
  }
  throw new ValidationError('Could not find a free name in comms/drafts/');
}

/** One draft: { path, etag, draft }. */
export async function readDraft(folio, path) {
  const p = String(path || '').replace(/^\/+/, '');
  if (!isDraftPath(p)) throw new ValidationError('Give the path of a draft in comms/drafts/');
  const cur = await folio.fs.read(p);
  if (!cur) throw new NotFoundError(p);
  let draft;
  try {
    draft = JSON.parse(cur.text);
  } catch {
    throw new ValidationError(`${p} is not a readable draft`);
  }
  return { path: p, etag: cur.etag, draft };
}

/** Every draft, oldest first: [{ path, at, author, text, to, attachments?, updated_at? }]. */
export async function listDrafts(folio) {
  const paths = (await folio.fs.list(DRAFTS_DIR)).filter(isDraftPath);
  const out = [];
  for (const path of paths) {
    try {
      const { draft } = await readDraft(folio, path);
      out.push({ path, at: draft.at, author: draft.author, text: draft.text, to: draft.to, ...(draft.attachments ? { attachments: draft.attachments } : {}), ...(draft.updated_at ? { updated_at: draft.updated_at, updated_by: draft.updated_by } : {}) });
    } catch {
      /* skip unreadable drafts */
    }
  }
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

/** Change a draft's text or recipients. Returns { path, draft }. */
export async function editDraft(folio, path, { text, to, actor }) {
  const cur = await readDraft(folio, path);
  const next = { ...cur.draft };
  if (text !== undefined) next.text = checkText(text).text;
  if (to !== undefined) next.to = cleanTo(to);
  next.updated_at = folio.now();
  next.updated_by = actor || { type: 'unknown' };
  await folio.fs.write(cur.path, json(next), { ifMatch: cur.etag, contentType: 'application/json' });
  return { path: cur.path, draft: next };
}

/** Throw a draft away. */
export async function discardDraft(folio, path) {
  const cur = await readDraft(folio, path);
  await folio.fs.remove(cur.path);
  return { path: cur.path, discarded: true };
}
