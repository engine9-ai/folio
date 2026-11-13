import { ValidationError } from './errors.js';
import { cleanEmailText, forwardedHeaders, parseEmail } from './email.js';
import { scrubText } from './privacy.js';
import { authorChannel, ccAudience, ccKey, findCc } from './cc.js';

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
 *   { "at", "kind", "author": { type, id, name?, on_behalf_of?, channel?, workspace? }, "via", "text",
 *     "attachments"?: [paths], "imported"?: { source, author, at }, "ref"?: { channel, id }, "task"?: "tasks/<dir>" }
 * `task` says the message is about one of the folio's tasks (tasks.js): its start, or how it ended.
 *
 * Two audiences (cc.js). A message with no `to` is for the team: everyone who can open the folio, and the CCs on
 * its team list. `to: [cc keys]` makes it a message to the client: sent to exactly those client CCs (and seen by
 * the team as always). `author.channel` says the message came in over a channel (a Slack reply, an SMS) from one
 * of the folio's CCs; `ref` is that channel's own id for the message, so a second delivery is not stored twice.
 *
 * The client thread: what was sent to the client (`to`), and what came from them (a message or email from a
 * client CC, or an email from anyone not on the team). readComms tags each item `thread: "team" | "client"` and
 * client items `direction: "in" | "out"`, so a page can show one interleaved conversation and still pick out what
 * the client has seen; clientThread() reads the timing from it (who is waiting on whom, and since when).
 */

export const COMMS_DIR = 'comms';
export const MESSAGE_KINDS = Object.freeze(['comment', 'update', 'agent', 'chat']);
export const COMMS_KINDS = Object.freeze([...MESSAGE_KINDS, 'email', 'summary']);

const MESSAGE_FILE = /\.(comment|update|agent|chat)\.json$/i;
const EMAIL_FILE = /\.(eml|msg)$/i;
const SUMMARY_FILE = /\.summary\.md$/i;

/**
 * Messages kept from the client (SPEC 5.7.2): the paths, in comms/, of messages and emails that a client must never
 * see even though the thread rule would show them (a third party's email, a message sent by mistake). Kept beside
 * the messages, because an email is stored as received and cannot carry a flag of its own.
 */
export const HIDDEN_FILE = `${COMMS_DIR}/hidden.json`;

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
export async function postMessage(folio, { kind = 'comment', text, attachments = [], actor, via = 'folio-lib', at = null, imported = null, ref = null, to = null, task = null }) {
  if (!MESSAGE_KINDS.includes(kind)) throw new ValidationError(`A message is one of ${MESSAGE_KINDS.join(', ')}`);
  if (!text || !String(text).trim()) throw new ValidationError('A message cannot be empty');
  if (to !== null && (!Array.isArray(to) || !to.length || to.some((k) => typeof k !== 'string' || !k))) throw new ValidationError('`to` lists the keys of the client CCs a message goes to');
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
    ...(ref ? { ref } : {}),
    ...(to ? { to: [...new Set(to)] } : {}),
    ...(task ? { task } : {}),
  };
  let name = messageName(when, clean, kind);
  if (ref) {
    // A message from a channel carries the channel's id for it: the same message delivered again is not stored twice.
    const h = await refHash(`${ref.channel || ''}:${ref.id}`);
    const existing = (await folio.fs.list(COMMS_DIR)).find((p) => p.includes(`-${h}.`) && MESSAGE_FILE.test(p));
    if (existing) return { path: existing, message: null, duplicate: true };
    name = name.replace(`.${kind}.json`, `-${h}.${kind}.json`);
  }
  const stem = name.slice(0, -`.${kind}.json`.length);
  for (let n = 1; n <= 200; n++) {
    const path = `${COMMS_DIR}/${n === 1 ? name : `${stem}-${n}.${kind}.json`}`;
    try {
      await folio.fs.write(path, json(message), { ifMatch: null, contentType: 'application/json' });
      // Hosts are told about new messages (to pass them on to the folio's CCs); imported history is not news.
      if (folio.onMessage && !imported) await folio.onMessage({ path, ...message });
      return { path, message, ...(total ? { removed } : {}) };
    } catch (e) {
      if (e?.code !== 'conflict') throw e;
    }
  }
  throw new ValidationError('Could not find a free name in comms/');
}

async function refHash(s) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s))));
  return [...d.slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Emails are in comms/, beside the other messages. */
export const isEmailPath = (p) => EMAIL_FILE.test(p) && p.startsWith(`${COMMS_DIR}/`) && !p.slice(COMMS_DIR.length + 1).includes('/');

/**
 * The conversation, newest last: every message and email in comms/. Each item:
 *   { kind, path, at, author, text, thread: "team" | "client", direction?: "in" | "out", to?, subject?, from?, truncated? }
 * For a message, `to` is the client CCs it was sent to (keys); for an email, the To header (`to_header`).
 * `cc` (the folio's CC list) marks messages that came from a CC with `cc: <its key>`. `team(channel, address)`, if
 * given, says whether a sender not on the CC list is on the team (staff email domains, say); otherwise only team
 * CCs and members posting in the folio count as the team. `limit` keeps the newest.
 */
export async function readComms(folio, { limit = 200, maxChars = 4000, read, cc = [], team = null, clean = false } = {}) {
  const fs = folio.fs;
  const all = await fs.list(COMMS_DIR);
  const paths = all.filter((p) => commsKindOf(p) && !p.slice(COMMS_DIR.length + 1).includes('/'));
  const [files, hidden] = await Promise.all([read(paths, (p) => (/\.msg$/i.test(p) ? null : fs.read(p))), all.includes(HIDDEN_FILE) ? readHidden(fs) : new Set()]);
  const items = [];
  for (const [i, path] of paths.entries()) {
    const kind = commsKindOf(path);
    const cur = files[i];
    if (kind === 'email') {
      const parsed = cur ? parseEmail(cur.text) : null;
      const full = parsed?.text || '';
      const h = parsed?.headers || {};
      const fwd = forwardedHeaders(full);
      const cleaned = clean ? cleanEmailText(full) : null;
      const text = cleaned ? cleaned.text : full;
      items.push({ kind, path, at: isoOf(h.date) || dateFromName(path), author: { type: 'email', id: h.from || null }, from: h.from || null, to_header: h.to || null, subject: h.subject || null, ...(fwd?.from ? { forwarded_from: fwd.from } : {}), text: text.slice(0, maxChars), ...(text.length > maxChars ? { truncated: true } : {}), ...(cleaned?.trimmed ? { cleaned: true } : {}) });
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
    items.push({ kind, path, at: m.at || dateFromName(path), author: m.author || { type: 'unknown' }, via: m.via, text: text.slice(0, maxChars), ...(text.length > maxChars ? { truncated: true } : {}), ...(m.attachments ? { attachments: m.attachments } : {}), ...(Array.isArray(m.to) && m.to.length ? { to: m.to.map(String) } : {}), ...(m.imported ? { imported: m.imported } : {}), ...(m.task ? { task: m.task } : {}) });
  }
  // Credit messages from the folio's CCs: an email from a CC'd address, a reply from a CC'd Slack channel.
  if (cc.length)
    for (const it of items) {
      const from = authorChannel(it.kind === 'email' ? { type: 'email', id: it.from } : it.author);
      const hit = from && findCc(cc, from);
      if (hit) {
        it.cc = ccKey(hit);
        if (hit.name && !it.author.name) it.author = { ...it.author, name: hit.name };
      }
    }
  for (const it of items) Object.assign(it, threadOf(it, cc, team));
  for (const it of items) if (hidden.has(it.path)) it.hidden_from_client = true;
  items.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')) || a.path.localeCompare(b.path));
  return limit && items.length > limit ? items.slice(-limit) : items;
}

/**
 * Which thread an item is in. Sent to client CCs: client, out. From a client CC: client, in. An email from anyone
 * not on the team: client, in (the ticket that started it, a forwarded complaint). Everything else: team.
 */
function threadOf(it, cc, team) {
  if (Array.isArray(it.to) && it.to.length) return { thread: 'client', direction: 'out' };
  if (it.kind === 'summary') return { thread: 'team' };
  const hit = it.cc ? cc.find((c) => ccKey(c) === it.cc) : null;
  if (hit) return ccAudience(hit) === 'team' ? { thread: 'team' } : { thread: 'client', direction: 'in' };
  if (it.kind === 'email') {
    const from = authorChannel({ type: 'email', id: it.from });
    const ours = (who) => Boolean(who && (team?.(who.channel, who.address) || cc.some((c) => ccAudience(c) === 'team' && c.channel === who.channel && String(c.address).toLowerCase() === who.address)));
    if (!ours(from)) return { thread: 'client', direction: 'in' };
    // Someone on the team forwarded it in: when the message they forwarded came from outside the team, it is the
    // client's (the ticket that started it), and the client is waiting from then.
    const original = it.forwarded_from ? authorChannel({ type: 'email', id: it.forwarded_from }) : null;
    if (original && !ours(original)) return { thread: 'client', direction: 'in', forwarded: true };
    return { thread: 'team' };
  }
  return { thread: 'team' };
}

async function readHidden(fs) {
  try {
    const cur = await fs.read(HIDDEN_FILE);
    const list = JSON.parse(cur?.text || '{}').paths;
    return new Set(Array.isArray(list) ? list.map(String) : []);
  } catch {
    return new Set();
  }
}

/**
 * Keep a message or email from the client, or stop keeping it (SPEC 5.7.2). `path` is its path in comms/.
 * Returns { path, hidden }.
 */
export async function setHiddenFromClient(folio, path, hidden = true, { actor = null } = {}) {
  const p = String(path || '').replace(/^\/+/, '');
  if (!commsKindOf(p) || !p.startsWith(`${COMMS_DIR}/`) || p.slice(COMMS_DIR.length + 1).includes('/')) throw new ValidationError('Give the path of a message or email in comms/');
  const fs = folio.fs;
  if (!(await fs.list(COMMS_DIR)).includes(p)) throw new ValidationError(`${p} is not in this folio's conversation`);
  for (let attempt = 0; attempt < 5; attempt++) {
    let cur = null;
    try {
      cur = await fs.read(HIDDEN_FILE);
    } catch {
      cur = null;
    }
    let data = { paths: [], changes: [] };
    try {
      data = { paths: [], changes: [], ...JSON.parse(cur?.text || '{}') };
    } catch {
      /* start again */
    }
    const set = new Set(data.paths);
    if (hidden ? set.has(p) : !set.has(p)) return { path: p, hidden: Boolean(hidden) };
    if (hidden) set.add(p);
    else set.delete(p);
    const next = { paths: [...set].sort(), changes: [...(data.changes || []), { at: folio.now(), path: p, hidden: Boolean(hidden), actor }].slice(-200) };
    try {
      await fs.write(HIDDEN_FILE, json(next), { ifMatch: cur ? cur.etag : null, contentType: 'application/json' });
      return { path: p, hidden: Boolean(hidden) };
    } catch (e) {
      if (e?.code !== 'conflict') throw e;
    }
  }
  throw new ValidationError('Someone else changed what the client sees at the same time; try again');
}

/**
 * The timing of the client thread, from readComms' items (oldest first), or null when there is none:
 *   { waiting: "us" | "client", since,          who is waiting, and since when: "us" since the first client message
 *                                               not yet answered, "client" since the last thing sent to them
 *     first_in, first_reply, last_in, last_out, the first client message, the first answer after it, the latest each way
 *     unanswered,                               client messages since the last thing sent to them
 *     sent, received }                          counts each way
 */
export function clientThread(items) {
  const client = (items || []).filter((m) => m.thread === 'client' && m.at && !m.hidden_from_client);
  if (!client.length) return null;
  let first_in = null;
  let first_reply = null;
  let last_in = null;
  let last_out = null;
  let pending = null;
  let unanswered = 0;
  let sent = 0;
  let received = 0;
  for (const m of client) {
    if (m.direction === 'out') {
      sent++;
      last_out = m.at;
      if (first_in && !first_reply) first_reply = m.at;
      pending = null;
      unanswered = 0;
    } else {
      received++;
      last_in = m.at;
      if (!first_in) first_in = m.at;
      if (!pending) pending = m.at;
      unanswered++;
    }
  }
  const waiting = pending ? 'us' : 'client';
  return { waiting, since: pending || last_out, first_in, first_reply, last_in, last_out, unanswered, sent, received };
}

function isoOf(d) {
  const t = Date.parse(d || '');
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function dateFromName(path) {
  const m = /(\d{4}-\d{2}-\d{2})(?:-(\d{2})(\d{2})(\d{2}))?/.exec(path.split('/').pop());
  return m ? `${m[1]}T${m[2] || '00'}:${m[3] || '00'}:${m[4] || '00'}.000Z` : null;
}
