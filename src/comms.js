import { ValidationError } from './errors.js';
import { parseEmail } from './email.js';
import { scrubText } from './privacy.js';

/**
 * Communications: every piece of back-and-forth about the work lives in ONE folder, `comms/`, whatever it is.
 * The extension says what kind of message a file is; the name starts with its date and time, so the folder lists
 * in order and a conversation reads top to bottom without visiting several folders:
 *
 *   comms/2026-11-02-donate-button-broken-1a2b3c4d.eml        an email, as received (or a text copy, spec 3.7)
 *   comms/2026-11-09-153012-pat-confirm-the-split.comment.json   a comment
 *   comms/2026-11-09-160000-weekly-status.update.json         a status update
 *   comms/2026-11-09-161500-ran-the-pii-scan.agent.json        something an agent reports
 *   comms/2026-11-09-170000-slack-thread.chat.json             a captured chat
 *   comms/2026-11-30-000000-through-november.summary.md        a summary that stands in for older messages
 *
 * Files people add (screenshots, documents, an email's attachments) are assets, kept apart in `attachments/`, so the conversation folder stays small enough to read, summarise and
 * compress. A message refers to assets by path.
 *
 * A message file (.comment/.update/.agent/.chat .json):
 *   { "at", "kind", "author": { type, id, on_behalf_of? }, "via", "text",
 *     "attachments"?: [paths], "imported"?: { source, author, at } }
 */

export const COMMS_DIR = 'comms';
export const MESSAGE_KINDS = Object.freeze(['comment', 'update', 'agent', 'chat']);
export const COMMS_KINDS = Object.freeze([...MESSAGE_KINDS, 'email', 'summary']);

const MESSAGE_FILE = /\.(comment|update|agent|chat)\.json$/i;
const EMAIL_FILE = /\.(eml|msg)$/i;
const SUMMARY_FILE = /\.summary\.md$/i;

/** What kind of message a comms file is, from its name; null for anything else. */
export function commsKindOf(path) {
  const name = String(path || '');
  const m = MESSAGE_FILE.exec(name);
  if (m) return m[1].toLowerCase();
  if (EMAIL_FILE.test(name)) return 'email';
  if (SUMMARY_FILE.test(name)) return 'summary';
  return null;
}

const json = (o) => JSON.stringify(o, null, 2) + '\n';

function slug(s, max = 40) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
}

/** "2026-11-09-153012-<slug>.<kind>.json", unique in comms/. */
export function messageName(at, text, kind) {
  const stamp = String(at).replace(/\.\d+Z?$/, '').replace(/Z$/, '').replace('T', '-').replace(/:/g, '');
  return `${stamp.slice(0, 17)}-${slug(String(text).split('\n').find((l) => l.trim()) || kind) || kind}.${kind}.json`;
}

/**
 * Write a message to comms/. Text is scrubbed of card numbers and credentials (spec 3.7). Returns
 * { path, message, removed? }.
 */
export async function postMessage(folio, { kind = 'comment', text, attachments = [], actor, via = 'folio-lib', at = null, imported = null }) {
  if (!MESSAGE_KINDS.includes(kind)) throw new ValidationError(`A message is one of ${MESSAGE_KINDS.join(', ')}`);
  if (!text || !String(text).trim()) throw new ValidationError('A message cannot be empty');
  const { text: clean, removed, total } = scrubText(String(text));
  const when = at || folio.now();
  const message = {
    at: when,
    kind,
    author: actor || { type: 'unknown' },
    via,
    text: clean,
    ...(attachments.length ? { attachments } : {}),
    ...(imported ? { imported } : {}),
  };
  const name = messageName(when, clean, kind);
  const stem = name.slice(0, -`.${kind}.json`.length);
  for (let n = 1; n <= 200; n++) {
    const path = `${COMMS_DIR}/${n === 1 ? name : `${stem}-${n}.${kind}.json`}`;
    try {
      await folio.fs.write(path, json(message), { ifMatch: null, contentType: 'application/json' });
      return { path, message, ...(total ? { removed } : {}) };
    } catch (e) {
      if (e?.code !== 'conflict') throw e;
    }
  }
  throw new ValidationError('Could not find a free name in comms/');
}

/** Where emails are: comms/ now, sources/email/ in folios written before comms/ existed. */
export const EMAIL_DIRS = Object.freeze([COMMS_DIR, 'sources/email']);
export const isEmailPath = (p) => EMAIL_FILE.test(p) && EMAIL_DIRS.some((d) => p.startsWith(`${d}/`) && !p.slice(d.length + 1).includes('/'));

/**
 * The conversation, newest last: every message in comms/, emails (also from the older sources/email/), and
 * comments recorded as ticket events by earlier versions. Each item:
 *   { kind, path, at, author, text, ticket?, subject?, from?, to?, truncated? }
 * `ticket` keeps one ticket's messages (and emails linked from it). `limit` keeps the newest.
 */
export async function readComms(folio, { limit = 200, maxChars = 4000, read } = {}) {
  const fs = folio.fs;
  const paths = [...new Set([...(await fs.list(COMMS_DIR)), ...(await fs.list('sources/email'))])].filter((p) => commsKindOf(p) && (p.startsWith(`${COMMS_DIR}/`) ? !p.slice(COMMS_DIR.length + 1).includes('/') : isEmailPath(p)));
  const files = await read(paths, (p) => (/\.msg$/i.test(p) ? null : fs.read(p)));
  const items = [];
  for (const [i, path] of paths.entries()) {
    const kind = commsKindOf(path);
    const cur = files[i];
    if (kind === 'email') {
      const parsed = cur ? parseEmail(cur.text) : null;
      const text = parsed?.text || '';
      const h = parsed?.headers || {};
      items.push({ kind, path, at: isoOf(h.date) || dateFromName(path), author: { type: 'email', id: h.from || null }, from: h.from || null, to: h.to || null, subject: h.subject || null, text: text.slice(0, maxChars), ...(text.length > maxChars ? { truncated: true } : {}) });
      continue;
    }
    if (!cur) continue;
    if (kind === 'summary') {
      items.push({ kind, path, at: dateFromName(path), author: { type: 'summary' }, text: cur.text.slice(0, maxChars) });
      continue;
    }
    let m;
    try {
      m = JSON.parse(cur.text);
    } catch {
      continue;
    }
    const text = String(m.text || '');
    items.push({ kind, path, at: m.at || dateFromName(path), author: m.author || { type: 'unknown' }, via: m.via, text: text.slice(0, maxChars), ...(text.length > maxChars ? { truncated: true } : {}), ...(m.attachments ? { attachments: m.attachments } : {}), ...(m.imported ? { imported: m.imported } : {}) });
  }
  items.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')) || a.path.localeCompare(b.path));
  return limit && items.length > limit ? items.slice(-limit) : items;
}

function isoOf(d) {
  const t = Date.parse(d || '');
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function dateFromName(path) {
  const m = /(\d{4}-\d{2}-\d{2})(?:-(\d{2})(\d{2})(\d{2}))?/.exec(path.split('/').pop());
  return m ? `${m[1]}T${m[2] || '00'}:${m[3] || '00'}:${m[4] || '00'}.000Z` : null;
}
