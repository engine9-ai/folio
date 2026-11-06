import { ConflictError, ValidationError } from './errors.js';
import { normalizePath } from './fs.js';
import { looksLikeEmail, parseEmailHeaders } from './email.js';
import { parseGithubUrl, repositoryKey } from './repositories.js';
import { isTicketId } from './tickets.js';

/**
 * Intake: decide where something added to a folio belongs, then put it there.
 * The hosted service only hands items over (a drag and drop, an upload, a
 * forwarded email); the routing rules live here so every interface files
 * things the same way.
 *
 * An item is { name?, type?, data?, text?, url?, path? }:
 *   data  file bytes (Uint8Array/ArrayBuffer) or a string
 *   text  dropped or pasted text
 *   url   a link
 *   path  the item's relative path inside a dropped folder ("Designs/v2/logo.png")
 *
 * Kinds and where they go:
 *   repository  a git repository URL   -> listed in folio.json `repositories` (spec 3.2.1)
 *   email       .eml, .msg, raw MIME   -> sources/email/<date>-<subject>-<hash>.eml (spec 8.1)
 *   link        any other URL          -> sources/links/<date>-<site>-<hash>.json
 *   note        plain text             -> notes/<date>-<first-line>.md
 *   file        anything else          -> sources/uploads/ (spec 8.4)
 *
 * With a ticket (dropped on a ticket, or forwarded to a ticket's address): files go to
 * tickets/<id>/attachments/, emails stay in sources/email/, and the ticket gets a link to
 * them; a link is recorded on the ticket; text becomes a comment. With a folder (dropped
 * on a folder), files go into that folder. Emails, repositories and links always go to
 * their own places, wherever they were dropped.
 */

export const INTAKE_KINDS = ['repository', 'email', 'link', 'note', 'file'];

const enc = new TextEncoder();
const json = (o) => JSON.stringify(o, null, 2) + '\n';

export function toBytes(data) {
  if (data === undefined || data === null) return null;
  if (typeof data === 'string') return enc.encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new ValidationError('Item data must be text or bytes');
}
const peek = (bytes, n = 16384) => new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, n));
const extOf = (name) => (/\.([a-z0-9]{1,10})$/i.exec(name || '')?.[1] || '').toLowerCase();

async function shortHash(input) {
  const digest = await crypto.subtle.digest('SHA-256', typeof input === 'string' ? enc.encode(input) : input);
  return [...new Uint8Array(digest)].slice(0, 4).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function slugify(s, max = 48) {
  const out = String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^(re|fwd?|aw|wg)\s*:\s*/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
  return out;
}

/** A safe single path segment from a user-supplied file name. */
export function safeName(name) {
  const s = String(name || '')
    .replace(/[/\\\0-\x1f\x7f]/g, '-')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(0, 150);
  return s && s !== '.' && s !== '..' ? s : 'untitled';
}

// ---- URLs ----

const GITHUB_NOT_REPOS = new Set(['orgs', 'settings', 'marketplace', 'features', 'topics', 'sponsors', 'notifications', 'login', 'join', 'about', 'pricing', 'enterprise', 'collections', 'explore', 'apps', 'search', 'new', 'organizations', 'trending', 'issues', 'pulls', 'codespaces', 'site', 'security', 'customer-stories', 'readme']);
const URLISH = /^(?:https?:\/\/|ssh:\/\/|git:\/\/|git@[^:\s]+:)\S+$/i;

/** If the URL points at a git repository (or something inside one), the repository entry to list; else null. */
export function repositoryFromUrl(input) {
  const s = String(input || '').trim();
  const scp = /^git@([^:\s]+):([^\s]+?)(?:\.git)?\/?$/.exec(s);
  if (scp) {
    const [, host, path] = scp;
    if (host === 'github.com') return { provider: 'github', repository: path, url: `https://github.com/${path}` };
    return { provider: host === 'gitlab.com' ? 'gitlab' : host === 'bitbucket.org' ? 'bitbucket' : 'git', repository: path, url: s };
  }
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.username || u.password) throw new ValidationError('That link has a user name or password in it. Folios must not contain credentials.');
  const parts = u.pathname.split('/').filter(Boolean);
  const host = u.hostname.replace(/^www\./, '');
  if (host === 'github.com') {
    if (parts.length < 2 || GITHUB_NOT_REPOS.has(parts[0].toLowerCase())) return null;
    const gh = parseGithubUrl(s);
    return gh ? { provider: 'github', repository: gh.repository, url: gh.url, ...(gh.ref ? { ref: gh.ref } : {}) } : null;
  }
  if (host === 'gitlab.com') {
    const cut = parts.indexOf('-');
    const repoParts = (cut === -1 ? parts : parts.slice(0, cut)).map((p) => p.replace(/\.git$/, ''));
    if (repoParts.length < 2 || ['explore', 'users', 'dashboard', 'help'].includes(repoParts[0])) return null;
    return { provider: 'gitlab', repository: repoParts.join('/'), url: `https://gitlab.com/${repoParts.join('/')}` };
  }
  if (host === 'bitbucket.org') {
    if (parts.length < 2 || ['account', 'dashboard', 'product'].includes(parts[0])) return null;
    const repository = `${parts[0]}/${parts[1].replace(/\.git$/, '')}`;
    return { provider: 'bitbucket', repository, url: `https://bitbucket.org/${repository}` };
  }
  if (u.protocol === 'ssh:' || u.protocol === 'git:' || /\.git\/?$/.test(u.pathname)) return { provider: 'git', url: s.replace(/\/$/, '') };
  return null;
}

/** URLs in dropped text, if the text is nothing but URLs (one per line; "#" lines are text/uri-list comments). */
export function urlsIn(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  return lines.length && lines.every((l) => URLISH.test(l)) ? lines : [];
}

function urlFromShortcut(name, text) {
  const ext = extOf(name);
  if (ext === 'webloc') return /<key>URL<\/key>\s*<string>([^<]+)<\/string>/i.exec(text)?.[1]?.trim() || null;
  if (ext === 'url' || ext === 'desktop') return /^URL=(.+)$/m.exec(text)?.[1]?.trim() || null;
  return null;
}

// ---- classification ----

/**
 * What kind of item is this? Pure: reads only the item. Returns { kind, ... }.
 * A text of several URLs classifies as { kind: 'urls', urls }; add() splits it.
 */
export function classify(item = {}) {
  const viaUrl = (url) => {
    const repository = repositoryFromUrl(url);
    return repository ? { kind: 'repository', url: url.trim(), repository } : { kind: 'link', url: url.trim() };
  };
  if (item.url) return viaUrl(item.url);
  const bytes = toBytes(item.data);
  if (!bytes) {
    const text = String(item.text ?? '');
    if (!text.trim()) throw new ValidationError('Nothing to add');
    const urls = urlsIn(text);
    if (urls.length === 1) return viaUrl(urls[0]);
    if (urls.length > 1) return { kind: 'urls', urls };
    if (looksLikeEmail(text)) return { kind: 'email', format: 'eml' };
    return { kind: 'note' };
  }
  const name = item.name || '';
  const ext = extOf(name);
  const type = String(item.type || '').toLowerCase();
  if (ext === 'eml' || type === 'message/rfc822') return { kind: 'email', format: 'eml' };
  if (ext === 'msg' || type === 'application/vnd.ms-outlook') return { kind: 'email', format: 'msg' };
  if (['webloc', 'url', 'desktop'].includes(ext)) {
    const url = urlFromShortcut(name, peek(bytes));
    if (url) return viaUrl(url);
  }
  if ((!ext || ext === 'txt') && looksLikeEmail(peek(bytes))) return { kind: 'email', format: 'eml' };
  return { kind: 'file' };
}

// ---- placement ----

async function createUnique(fs, dir, name, data, contentType) {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 1; n <= 200; n++) {
    const path = normalizePath(`${dir}/${n === 1 ? name : `${stem} ${n}${ext}`}`);
    try {
      await fs.write(path, data, { ifMatch: null, ...(contentType ? { contentType } : {}) });
      return path;
    } catch (e) {
      if (!(e instanceof ConflictError)) throw e;
    }
  }
  throw new ConflictError(`${dir}/${name}`, `Could not find a free name for ${name} in ${dir}`);
}

/** Where a file dropped on `folder` should go, or a ticket if the folder is inside one. */
function fileDestination({ ticket, folder }) {
  if (ticket) return { dir: `tickets/${ticket}/attachments`, ticket };
  if (folder) {
    const clean = normalizePath(folder);
    const m = /^tickets\/(TK-\d+)(?:\/|$)/.exec(clean);
    if (m) return { dir: `tickets/${m[1]}/attachments`, ticket: m[1] };
    if (clean === 'tickets' || clean === 'sources/email' || clean === 'history' || clean.startsWith('history/')) return { dir: 'sources/uploads' };
    return { dir: clean };
  }
  return { dir: 'sources/uploads' };
}

function relativeDirs(path) {
  if (!path) return '';
  const parts = String(path).split(/[/\\]/).filter(Boolean).slice(0, -1).map(safeName);
  return parts.length ? `/${parts.join('/')}` : '';
}

/**
 * Add one item to the folio. Returns an array of results (a text of several URLs adds several).
 * Each result: { kind, path?, repository?, url?, ticket?, duplicate?, summary }.
 */
export async function addItem(folio, item, { ticket, folder, actor = { type: 'unknown' }, via = 'folio-lib' } = {}) {
  if (ticket !== undefined && ticket !== null && ticket !== '') {
    if (!isTicketId(ticket)) throw new ValidationError(`${ticket} is not a ticket id`);
    await folio.getTicket(ticket); // must exist
  } else ticket = null;
  const c = classify(item);
  if (c.kind === 'urls') {
    const out = [];
    for (const url of c.urls) out.push(...(await addItem(folio, { url }, { ticket, folder, actor, via })));
    return out;
  }
  const fs = folio.fs;
  const day = (iso) => String(iso || folio.now()).slice(0, 10);
  const record = (extra) => writeIntakeRecord(folio, { actor, via, ...extra });

  if (c.kind === 'repository') {
    const listed = (await folio.repositories()).find((r) => repositoryKey(r) === repositoryKey(c.repository));
    const label = c.repository.repository || c.repository.url;
    if (!listed) {
      const { ref, ...entry } = c.repository;
      await folio.addRepository(entry, { actor });
    }
    if (ticket && c.url !== c.repository.url) await folio.linkTicket(ticket, { type: 'url', label: c.url, url: c.url }, { actor, via });
    return [{ kind: 'repository', repository: label, url: c.url, duplicate: Boolean(listed), ...(ticket ? { ticket } : {}), summary: listed ? `${label} is already listed` : `Listed repository ${label}` }];
  }

  if (c.kind === 'link') {
    if (ticket) {
      await folio.linkTicket(ticket, { type: 'url', label: item.name || c.url, url: c.url }, { actor, via });
      return [{ kind: 'link', url: c.url, ticket, summary: `Linked ${c.url} to ${ticket}` }];
    }
    const h = await shortHash(c.url);
    const existing = (await fs.list('sources/links')).find((p) => p.endsWith(`-${h}.json`));
    if (existing) return [{ kind: 'link', url: c.url, path: existing, duplicate: true, summary: 'That link is already saved' }];
    let site = c.url;
    try {
      const u = new URL(c.url);
      site = u.hostname.replace(/^www\./, '') + u.pathname;
    } catch {
      /* keep as is */
    }
    const path = `sources/links/${day()}-${slugify(site, 40) || 'link'}-${h}.json`;
    await fs.write(path, json({ url: c.url, ...(item.name && item.name !== c.url ? { title: item.name } : {}), added_at: folio.now(), ...(actor?.id ? { added_by: actor.id } : {}), via }), { ifMatch: null });
    await record({ kind: 'link', path, url: c.url });
    return [{ kind: 'link', url: c.url, path, summary: `Saved link to ${site}` }];
  }

  if (c.kind === 'email') {
    const bytes = toBytes(item.data ?? item.text);
    const headers = c.format === 'eml' ? parseEmailHeaders(peek(bytes, 65536)) || {} : {};
    const h = await shortHash(headers.message_id ? headers.message_id.trim() : bytes);
    const existing = (await fs.list('sources/email')).find((p) => p.includes(`-${h}.`));
    let path = existing;
    if (!existing) {
      const name = `${day(headers.date)}-${slugify(headers.subject || (item.name || '').replace(/\.[^.]+$/, ''), 48) || 'email'}-${h}.${c.format}`;
      path = `sources/email/${name}`;
      await fs.write(path, bytes, { ifMatch: null, contentType: c.format === 'eml' ? 'message/rfc822' : 'application/vnd.ms-outlook' });
      await record({ kind: 'email', path, original_name: item.name, email: headers, ...(ticket ? { ticket } : {}) });
    }
    if (ticket) await folio.linkTicket(ticket, { type: 'source', label: headers.subject ? `Email: ${headers.subject}` : 'Email', path }, { actor, via });
    const what = headers.subject ? `“${headers.subject}”` : 'the email';
    return [{ kind: 'email', path, email: headers, duplicate: Boolean(existing), ...(ticket ? { ticket } : {}), summary: existing ? `${what} is already in this folio` : `Filed ${what} in sources/email` }];
  }

  if (c.kind === 'note') {
    const text = String(item.text ?? new TextDecoder().decode(toBytes(item.data)));
    if (ticket) {
      await folio.comment(ticket, text, { actor, via });
      return [{ kind: 'note', ticket, summary: `Added a comment to ${ticket}` }];
    }
    const first = text.trim().split(/\r?\n/)[0];
    const path = await createUnique(fs, 'notes', `${day()}-${slugify(first, 40) || 'note'}.md`, text.endsWith('\n') ? text : text + '\n', 'text/markdown');
    await record({ kind: 'note', path });
    return [{ kind: 'note', path, summary: `Saved a note in ${path}` }];
  }

  // file
  const bytes = toBytes(item.data ?? item.text ?? '');
  const dest = fileDestination({ ticket, folder });
  const name = safeName(item.name || 'untitled');
  const path = await createUnique(fs, dest.dir + relativeDirs(item.path), name, bytes, item.type || undefined);
  await record({ kind: 'file', path, original_name: item.name, content_type: item.type || null, size: bytes.byteLength, ...(dest.ticket ? { ticket: dest.ticket } : {}) });
  if (dest.ticket) await folio.linkTicket(dest.ticket, { type: 'attachment', label: name, path }, { actor, via });
  return [{ kind: 'file', path, ...(dest.ticket ? { ticket: dest.ticket } : {}), summary: `Added ${name} to ${path.slice(0, path.lastIndexOf('/'))}` }];
}

/**
 * Provenance for anything that is not otherwise attributed (spec 8.4): when, by whom and
 * how an item entered the folio. One small file per item under history/intake/.
 */
async function writeIntakeRecord(folio, { actor, via, ...rest }) {
  const at = folio.now();
  const stamp = at.replace(/[-:]/g, '').replace(/\.\d+/, '').replace('Z', 'Z');
  const h = await shortHash(`${at}:${rest.path || rest.url}:${Math.random()}`);
  const body = { at, ...(actor ? { actor } : {}), via, ...rest };
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  await folio.fs.write(`history/intake/${stamp}-${h}.json`, json(body), { ifMatch: null });
}
