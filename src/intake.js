import { ConflictError, ValidationError } from './errors.js';
import { normalizePath } from './fs.js';
import { emailAddress, emailAttachments, looksLikeEmail, parseEmail, parseEmailHeaders, rawHeaderBlock } from './email.js';
import { dataFormat, keepInFolio, summarizeData } from './data.js';
import { describeRemoved, prohibitedIn, scrubText } from './privacy.js';
import { parseGithubUrl, repositoryKey } from './repositories.js';
import { TEXT_FORMATS, detectTextFormat, textFormatOf, titleOfText } from './text-format.js';
import { detectImport, parseJsonText } from './import.js';
import { isEmailPath, postMessage } from './comms.js';

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
 *   email       .eml, .msg, raw MIME   -> comms/<date>-<subject>-<hash>.eml (spec 8.1; with every other message)
 *   link        any other URL          -> sources/links/<date>-<site>-<hash>.json
 *   note        plain text             -> notes/<date>-<first-line>.md
 *   data        a data file or log     -> summarised in sources/data/<date>-<name>-<hash>.json; the file
 *                                         itself goes to the host's temporary storage (spec 8.4.1)
 *   file        anything else          -> attachments/ (spec 8.4)
 *
 * Content policy (spec 3.7, GUIDE.md), applied here so every interface obeys it:
 *   - card, bank account and Social Security numbers and credentials are removed from notes, comments and
 *     text files; an email carrying them is stored as a text copy without them (the original is held);
 *   - data files and logs are summarised with personal data masked, unless small and free of personal data;
 *   - key and credential files (.env, .pem, id_rsa…) are refused; .git and node_modules folders are skipped.
 *
 * Something added to a folio inside a folio (a ticket, a task) is simply added to that folio. With a folder (dropped
 * on a folder), files go into that folder. Emails, repositories and links always go to
 * their own places, wherever they were dropped.
 */

export const INTAKE_KINDS = ['repository', 'email', 'link', 'note', 'message', 'data', 'file', 'import'];

/**
 * What an item may be saved as, overriding detection (item.as). 'auto' (or nothing) lets Folio decide.
 *   markdown | html | text   text saved as a .md, .html or .txt file (a file of those kinds gets that extension)
 *   json                     text saved as a .json file (filed like a dropped .json: data or an ordinary file)
 *   import                   an export from another tool turned into folios (Asana, Trello, a Folio list)
 *   comment                  text posted as a comment in comms/
 *   update                   text posted as a status update in comms/
 *   file                     a dropped file kept as a file, never imported
 */
export const INTAKE_AS = ['auto', 'markdown', 'html', 'text', 'json', 'import', 'comment', 'update', 'file'];

/** File names that are credentials by nature. They are refused, never stored. */
const CREDENTIAL_FILE = /(^|\/)(\.env(\.(?!example$|sample$|template$)[^/]+)?|\.netrc|\.pgpass|\.npmrc|id_(rsa|dsa|ecdsa|ed25519)|[^/]+\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|asc|gpg|ovpn|mobileprovision))$/i;
/** Folders that hold code or tooling, not evidence. Skipped inside a dropped folder. */
const SKIPPED_DIR = /(^|\/)(\.git|node_modules|\.venv|venv|__pycache__|\.terraform|vendor\/bundle)\//;

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
  const as = item.as && item.as !== 'auto' ? String(item.as) : null;
  if (as && !INTAKE_AS.includes(as)) throw new ValidationError(`Unknown type “${as}”. Use one of ${INTAKE_AS.join(', ')}.`);
  if (item.url) return viaUrl(item.url);
  const bytes = toBytes(item.data);
  if (!bytes) {
    const text = String(item.text ?? '');
    if (!text.trim()) throw new ValidationError('Nothing to add');
    if (!as) {
      const urls = urlsIn(text);
      if (urls.length === 1) return viaUrl(urls[0]);
      if (urls.length > 1) return { kind: 'urls', urls };
      if (looksLikeEmail(text)) return { kind: 'email', format: 'eml' };
    }
    if (!as || as === 'import' || as === 'json') {
      const doc = parseJsonText(text);
      if (doc === undefined && (as === 'import' || as === 'json')) throw new ValidationError('That is not valid JSON');
      if (doc !== undefined) {
        const found = as === 'json' ? null : detectImport(doc, { format: item.import_format });
        if (found) return { kind: 'import', ...found };
        if (as === 'import') throw new ValidationError(notImportable());
        const jsonBytes = enc.encode(text);
        return { kind: dataFormat({ name: 'pasted.json', type: 'application/json', bytes: jsonBytes }) ? 'data' : 'file', format: 'json', pasted: true };
      }
    }
    if (as === 'file') throw new ValidationError('Text is saved as a note; choose markdown, html, text or json');
    if (as === 'comment' || as === 'update') return { kind: 'note', format: detectTextFormat(text).format, comment: true, message: as };
    if (TEXT_FORMATS[as]) return { kind: 'note', format: as, chosen: true };
    const d = detectTextFormat(text);
    return { kind: 'note', format: d.format, reasons: d.reasons };
  }
  const name = item.name || '';
  const ext = extOf(name);
  const type = String(item.type || '').toLowerCase();
  if (item.path && SKIPPED_DIR.test(String(item.path).replace(/\\/g, '/'))) return { kind: 'skipped', reason: 'code' };
  if (CREDENTIAL_FILE.test(name)) return { kind: 'refused', reason: 'credential' };
  if (ext === 'eml' || type === 'message/rfc822') return { kind: 'email', format: 'eml' };
  if (ext === 'msg' || type === 'application/vnd.ms-outlook') return { kind: 'email', format: 'msg' };
  if (['webloc', 'url', 'desktop'].includes(ext)) {
    const url = urlFromShortcut(name, peek(bytes));
    if (url) return viaUrl(url);
  }
  if ((!ext || ext === 'txt') && looksLikeEmail(peek(bytes))) return { kind: 'email', format: 'eml' };
  if (as === 'import' || (!as && (ext === 'json' || type === 'application/json'))) {
    const doc = bytes.length <= 30 * 1024 * 1024 ? parseJsonText(bytes) : undefined;
    const found = doc === undefined ? null : detectImport(doc, { format: item.import_format });
    if (found) return { kind: 'import', ...found };
    if (as === 'import') throw new ValidationError(doc === undefined ? `${name || 'That file'} is not valid JSON` : notImportable());
  }
  const retype = TEXT_FORMATS[as] ? { retype: as } : {};
  const data = as === 'file' || retype.retype ? null : dataFormat({ name, type, bytes });
  if (data) return { kind: 'data', format: data.format };
  return { kind: 'file', ...retype };
}

const notImportable = () => 'This is not an export Folio can import. Folio imports Asana and Trello JSON exports, and { "folios": [...] }.';

/**
 * What Folio would do with an item and what else it could be saved as, for a "Save as" choice in an interface.
 * Returns { kind, ..., label, where, as, choices: [{ as, label }] }. Pure: reads only the item and the context.
 */
export function intakeChoices(item = {}, { folder } = {}) {
  const c = classify(item);
  const text = item.data === undefined || item.data === null;
  const fmtLabel = (f) => `${TEXT_FORMATS[f].label} (.${TEXT_FORMATS[f].ext})`;
  const noteWhere = folder ? `a new file in ${folder}/` : 'a new file in notes/';
  const choices = [];
  let as = item.as && item.as !== 'auto' ? item.as : 'auto';
  let label;
  let where;
  const textChoices = () => {
    for (const f of Object.keys(TEXT_FORMATS)) choices.push({ as: f, label: fmtLabel(f) });
    choices.push({ as: 'comment', label: 'Comment (in comms/)' }, { as: 'update', label: 'Status update (in comms/)' });
  };
  if (c.kind === 'import') {
    label = `${c.label} export: ${c.items} ${c.items === 1 ? 'item' : 'items'}`;
    where = `${c.items} new ${c.items === 1 ? 'folio' : 'folios'} inside this one (skipping any already imported)`;
    if (as === 'auto') as = 'import';
    choices.push({ as: 'import', label: `Import as folios (${c.label})` }, { as: text ? 'json' : 'file', label: 'Keep as a JSON file' });
  } else if (c.kind === 'note') {
    const f = c.format;
    if (c.comment) {
      label = c.message === 'update' ? 'Status update' : 'Comment';
      where = 'comms/';
      if (as === 'auto') as = 'comment';
    } else {
      label = `${fmtLabel(f)}${c.chosen ? '' : ' (detected)'}`;
      where = noteWhere;
      if (as === 'auto') as = f;
    }
    textChoices();
    if (parseJsonText(String(item.text ?? '')) !== undefined) choices.push({ as: 'json', label: 'JSON (.json)' });
  } else if (text && (c.kind === 'data' || c.kind === 'file') && c.pasted) {
    label = c.kind === 'data' ? 'JSON records (summarised as data)' : 'JSON (.json)';
    where = c.kind === 'data' ? 'a summary in sources/data/' : folder ? `a new file in ${folder}/` : 'attachments/';
    if (as === 'auto') as = 'json';
    choices.push({ as: 'json', label: 'JSON (.json)' });
    textChoices();
  } else {
    const kinds = { repository: 'Repository link', link: 'Web link', urls: 'Links', email: 'Email', data: 'Data file or log', file: 'File', refused: 'Refused', skipped: 'Skipped' };
    const places = { repository: 'folio.json repositories', link: 'sources/links/', urls: 'one entry per link', email: 'comms/', data: 'a summary in sources/data/', file: folder ? `${folder}/` : 'attachments/', refused: 'not stored', skipped: 'not stored' };
    label = kinds[c.kind] || c.kind;
    where = places[c.kind] || '';
    if (text && ['repository', 'link', 'urls', 'email'].includes(c.kind)) textChoices();
    if (!text && c.kind === 'file' && textFormatOf(item.name)) for (const f of Object.keys(TEXT_FORMATS)) choices.push({ as: f, label: fmtLabel(f) });
  }
  if (choices.length && !choices.some((x) => x.as === as) && as !== 'auto') as = choices[0].as;
  return { ...c, label, where, as, choices: choices.length > 1 ? choices : [] };
}

// ---- placement ----

export async function createUnique(fs, dir, name, data, contentType) {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 1; n <= 200; n++) {
    const file = n === 1 ? name : `${stem} ${n}${ext}`;
    const path = normalizePath(dir ? `${dir}/${file}` : file);
    try {
      await fs.write(path, data, { ifMatch: null, ...(contentType ? { contentType } : {}) });
      return path;
    } catch (e) {
      if (!(e instanceof ConflictError)) throw e;
    }
  }
  throw new ConflictError(`${dir}/${name}`, `Could not find a free name for ${name} in ${dir}`);
}

/** Where a file dropped on `folder` should go. */
function fileDestination({ folder }) {
  if (folder) {
    const clean = normalizePath(folder);
    if (clean === 'comms' || clean.startsWith('comms/') || clean === 'sources/email' || clean === 'history' || clean.startsWith('history/')) return { dir: 'attachments' };
    return { dir: clean };
  }
  return { dir: 'attachments' };
}

function relativeDirs(path) {
  if (!path) return '';
  const parts = String(path).split(/[/\\]/).filter(Boolean).slice(0, -1).map(safeName);
  return parts.length ? `/${parts.join('/')}` : '';
}

/**
 * Add one item to the folio. Returns an array of results (a text of several URLs adds several).
 * Each result: { kind, path?, repository?, url?, duplicate?, summary }.
 */
export async function addItem(folio, item, { folder, actor = { type: 'unknown' }, via = 'folio-lib' } = {}) {
  const c = classify(item);
  if (c.kind === 'urls') {
    const out = [];
    for (const url of c.urls) out.push(...(await addItem(folio, { url }, { folder, actor, via })));
    return out;
  }
  const fs = folio.fs;
  const day = (iso) => String(iso || folio.now()).slice(0, 10);
  const record = (extra) => writeIntakeRecord(folio, { actor, via, ...extra });
  const itemLabel = item.path || item.name || 'item';

  if (c.kind === 'skipped') return [{ kind: 'skipped', name: itemLabel, summary: `Skipped ${itemLabel}: code and tooling folders belong in a repository (list it in the folio instead)` }];
  if (c.kind === 'refused')
    return [{ kind: 'refused', name: itemLabel, summary: `Refused ${itemLabel}: folios must not hold keys or credentials. Record where it lives in your password manager instead.` }];

  if (c.kind === 'repository') {
    const listed = (await folio.repositories()).find((r) => repositoryKey(r) === repositoryKey(c.repository));
    const label = c.repository.repository || c.repository.url;
    if (!listed) {
      const { ref, ...entry } = c.repository;
      await folio.addRepository(entry, { actor });
    }
    // A release, pull request, issue, commit, branch or file: remembered on the repository's entry (spec 3.2.1).
    const ref = c.repository.ref ? await folio.addRepositoryReference(c.repository, { ...c.repository.ref, url: c.url }, { actor }) : null;
    const what = ref ? describeRef(ref) : null;
    const said = listed ? (ref?.added ? `Recorded ${what} on ${label}` : ref ? `${what} is already recorded on ${label}` : `${label} is already listed`) : `Listed repository ${label}${ref ? ` with ${what}` : ''}`;
    return [{ kind: 'repository', repository: label, url: c.url, duplicate: Boolean(listed) && !ref?.added, ...(ref ? { reference: ref.reference } : {}), summary: said }];
  }

  if (c.kind === 'link') {
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
    const existing = [...(await fs.list('comms')), ...(await fs.list('sources/email'))].find((p) => isEmailPath(p) && p.includes(`-${h}.`));
    let path = existing;
    let privacy = null;
    const extra = [];
    if (!existing) {
      const stem = `${day(headers.date)}-${slugify(headers.subject || (item.name || '').replace(/\.[^.]+$/, ''), 48) || 'email'}-${h}`;
      path = `comms/${stem}.${c.format}`;
      const raw = c.format === 'eml' ? peek(bytes, bytes.length) : null;
      const plan = raw ? emailPrivacy(raw, headers) : null;
      if (plan?.rewrite) {
        // The original carries what a folio must not hold: keep a text copy here, hold the original.
        const held = await holdBytes(folio, bytes, { name: `${stem}.eml`, type: 'message/rfc822', actor, via });
        const placed = [];
        for (const a of plan.attachments) {
          if (a.data) {
            const [r] = await addItem(folio, { name: a.name, type: a.type, data: a.bytes }, { actor, via: `${via}/email-attachment` });
            placed.push({ name: a.name, path: r.path, summary: r.summary });
            extra.push(r);
          } else {
            const scrubbed = scrubFile(a.name, a.bytes);
            const p = await createUnique(fs, `attachments/${stem}`, safeName(a.name), scrubbed.bytes, a.type || undefined);
            placed.push({ name: a.name, path: p, ...(scrubbed.total ? { removed: scrubbed.removed } : {}) });
          }
        }
        await fs.write(path, emailCopy(raw, plan, held, placed), { ifMatch: null, contentType: 'message/rfc822' });
        privacy = { copy: true, removed: plan.removed, held: held || { where: 'not_kept' }, attachments: placed };
      } else {
        await fs.write(path, bytes, { ifMatch: null, contentType: c.format === 'eml' ? 'message/rfc822' : 'application/vnd.ms-outlook' });
        if (!raw) privacy = { scanned: false, note: 'Outlook .msg files are not read, so not checked' };
      }
      await record({ kind: 'email', path, original_name: item.name, email: headers, ...(privacy ? { privacy } : {}) });
      if (folio.onMessage) {
        // Tell the host (it may pass the email on to the folio's CCs): the text as filed, never the held original.
        const filed = c.format === 'eml' ? await fs.read(path) : null;
        const text = filed ? parseEmail(filed.text)?.text || '' : '';
        await folio.onMessage({ path, kind: 'email', at: headers.date && !Number.isNaN(Date.parse(headers.date)) ? new Date(headers.date).toISOString() : folio.now(), author: { type: 'email', id: emailAddress(headers.from) || headers.from || null, ...(actor?.id ? { forwarded_by: actor.id } : {}) }, via, subject: headers.subject || null, from: headers.from || null, to: headers.to || null, text: text.slice(0, 20000) });
      }
    }
    const what = headers.subject ? `“${headers.subject}”` : 'the email';
    let summary = existing ? `${what} is already in this folio` : `Filed ${what} in comms`;
    if (privacy?.copy) {
      const why = [describeRemoved(privacy.removed), privacy.attachments.some((a) => extra.some((r) => r.path === a.path && r.kind === 'data')) ? 'data attachments (summarised)' : ''].filter(Boolean).join(' and ');
      summary += ` as a text copy without ${why}; ${heldPhrase(privacy.held, 'the original')}`;
    }
    return [{ kind: 'email', path, email: headers, duplicate: Boolean(existing), ...(privacy?.copy ? { privacy } : {}), summary }, ...extra];
  }

  if (c.kind === 'import') {
    const r = await folio.import(item.text ?? toBytes(item.data), { format: c.format, name: item.name, actor, via });
    return [{ kind: 'import', ...r }];
  }

  if (c.kind === 'note') {
    const raw = String(item.text ?? new TextDecoder().decode(toBytes(item.data)));
    const { text, removed, total } = scrubText(raw);
    const note = total ? ` (removed ${describeRemoved(removed)})` : '';
    const explicit = c.chosen && !c.comment;
    if (c.comment) {
      const kind = c.message || 'comment';
      const r = await postMessage(folio, { kind, text, actor, via });
      const what = kind === 'update' ? 'a status update' : 'a comment';
      return [{ kind: 'message', message: kind, path: r.path, ...(total ? { removed } : {}), summary: `Posted ${what}${note}` }];
    }
    const fmt = TEXT_FORMATS[c.format] || TEXT_FORMATS.text;
    const dest = folder ? fileDestination({ folder }) : { dir: 'notes' };
    const fileName = noteName(item.name, text, c.format, day());
    const path = await createUnique(fs, dest.dir, fileName, text.endsWith('\n') ? text : text + '\n', fmt.type);
    await record({ kind: 'note', path, format: c.format, ...(c.chosen ? { chosen: true } : { detected: c.reasons }), ...(total ? { privacy: { removed } } : {}) });
    const what = c.format === 'text' ? 'a text note' : `a ${fmt.label} note`;
    return [{ kind: 'note', path, format: c.format, ...(total ? { removed } : {}), summary: `Saved ${what} in ${path}${note}` }];
  }

  if (c.pasted) {
    // JSON pasted as text: filed exactly like a dropped .json file.
    const name = safeName(item.name ? String(item.name).replace(/\.json$/i, '') + '.json' : `${day()}-pasted.json`);
    return addItem(folio, { name, type: 'application/json', data: enc.encode(String(item.text)), as: 'json' }, { folder, actor, via });
  }

  if (c.kind === 'data') {
    const bytes = toBytes(item.data ?? item.text ?? '');
    const name = safeName(item.name || 'data');
    const summary = await summarizeData(bytes, { name, type: item.type, submitted_at: folio.now(), submitted_by: actor?.id, via });
    if (!keepInFolio(summary)) {
      const h8 = summary.sha256.slice(0, 8);
      const existing = (await fs.list('sources/data')).find((p) => p.endsWith(`-${h8}.json`));
      let path = existing;
      if (!existing) {
        summary.stored = (await holdBytes(folio, bytes, { name, type: item.type, sha256: summary.sha256, actor, via })) || {
          where: 'not_kept',
          note: 'This folio has no temporary storage, so only this summary was kept.',
        };
        path = `sources/data/${day()}-${slugify(name.replace(/\.[^.]+$/, ''), 40) || 'data'}-${h8}.json`;
        await fs.write(path, json(summary), { ifMatch: null, contentType: 'application/json' });
        await record({ kind: 'data', path, original_name: item.name, content_type: item.type || null, size: bytes.byteLength, sha256: summary.sha256, stored: summary.stored });
      }
      const shown = existing ? JSON.parse((await fs.read(existing)).text) : summary;
      return [{ kind: 'data', path, name, records: shown.records, pii: shown.pii.types, stored: shown.stored, duplicate: Boolean(existing), summary: existing ? `${name} is already summarised in ${existing}` : dataSentence(summary) }];
    }
    // Small and free of personal data: an ordinary file, with the summary in its provenance.
    return placeFile(folio, item, bytes, { folder, actor, via, record, data: { format: summary.format, records: summary.records, fields: summary.fields.length } });
  }

  // file
  return placeFile(folio, item, toBytes(item.data ?? item.text ?? ''), { folder, actor, via, record });
}

/** A note's file name: the given name (with the format's extension), else <date>-<title>.<ext>. */
function noteName(given, text, format, date) {
  const ext = (TEXT_FORMATS[format] || TEXT_FORMATS.text).ext;
  if (given && String(given).trim()) return `${safeName(String(given).trim().replace(/\.(md|markdown|html?|txt|text)$/i, ''))}.${ext}`;
  return `${date}-${slugify(titleOfText(text, format), 40) || 'note'}.${ext}`;
}

/** `name` with the extension of a text format. Only for text files (or names without an extension). */
function retyped(name, format) {
  const fmt = TEXT_FORMATS[format];
  if (!fmt) return name;
  if (!textFormatOf(name) && /\.[a-z0-9]{1,10}$/i.test(name) && !/\.(log|text|rtf)$/i.test(name)) throw new ValidationError(`${name} is not a text file, so it cannot be saved as ${fmt.label}`);
  return `${name.replace(/\.(md|markdown|html?|txt|text|log|rtf)$/i, '')}.${fmt.ext}`;
}

async function placeFile(folio, item, raw, { folder, actor, via, record, data }) {
  const dest = fileDestination({ folder });
  const c = classify(item);
  const name = c.retype ? retyped(safeName(item.name || 'untitled'), c.retype) : safeName(item.name || 'untitled');
  const { bytes, removed, total } = scrubFile(name, raw);
  const path = await createUnique(folio.fs, dest.dir + relativeDirs(item.path), name, bytes, (c.retype ? TEXT_FORMATS[c.retype].type : item.type) || undefined);
  await record({ kind: 'file', path, original_name: item.name, content_type: item.type || null, size: bytes.byteLength, ...(data ? { data } : {}), ...(total ? { privacy: { removed } } : {}) });
  return [{ kind: 'file', path, ...(total ? { removed } : {}), summary: `Added ${name} to ${path.slice(0, path.lastIndexOf('/'))}${total ? ` (removed ${describeRemoved(removed)})` : ''}` }];
}

// ---- content policy helpers ----

const BINARY_EXT = /\.(png|jpe?g|gif|webp|heic|heif|tiff?|bmp|ico|pdf|zip|gz|tgz|bz2|xz|7z|rar|docx?|xlsx?|pptx?|odt|ods|odp|key|numbers|pages|mp[34]|mov|m4a|wav|avi|mkv|webm|woff2?|ttf|otf|eot|exe|dll|so|dylib|bin|wasm)$/i;

/** A text file has prohibited content scrubbed (spec 3.7); binary files and images keep their bytes. */
function scrubFile(name, bytes) {
  if (BINARY_EXT.test(name) || bytes.byteLength > 10 * 1024 * 1024) return { bytes, removed: {}, total: 0 };
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { bytes, removed: {}, total: 0 };
  }
  if (text.slice(0, 8192).includes('\0')) return { bytes, removed: {}, total: 0 };
  const r = scrubText(text);
  return r.total ? { bytes: enc.encode(r.text), removed: r.removed, total: r.total } : { bytes, removed: {}, total: 0 };
}

/** Does an email need a text copy instead of its original? Prohibited content, or attachments that are data. */
function emailPrivacy(raw, headers) {
  const parsed = parseEmail(raw);
  const body = parsed?.text || '';
  const removed = prohibitedIn(`${headers.subject || ''}\n${body}`);
  const attachments = emailAttachments(raw).map((a) => ({ ...a, data: Boolean(dataFormat(a)) }));
  for (const a of attachments) {
    if (a.data) continue;
    const r = scrubFile(a.name, a.bytes);
    for (const [k, v] of Object.entries(r.removed)) removed[k] = (removed[k] || 0) + v;
  }
  const rewrite = Object.keys(removed).length > 0 || attachments.some((a) => a.data);
  return { rewrite, removed, body, attachments };
}

const DROPPED_HEADERS = /^(content-type|content-transfer-encoding|content-disposition|mime-version|content-id)\s*:/i;

/** The folio's copy of an email: original headers, the readable text scrubbed, and where everything went. */
function emailCopy(raw, plan, held, placed) {
  const lines = rawHeaderBlock(raw).split(/\r?\n/);
  const kept = [];
  let dropping = false;
  for (const line of lines) {
    if (/^[ \t]/.test(line)) {
      if (!dropping) kept.push(line);
      continue;
    }
    dropping = DROPPED_HEADERS.test(line);
    if (!dropping) kept.push(line);
  }
  const headerText = scrubText(kept.join('\r\n')).text;
  const what = describeRemoved(plan.removed);
  const footer = [
    '',
    '-- ',
    `Folio kept this text copy instead of the original${what ? `, without ${what}` : ''}. ${heldPhrase(held, 'The original')}.`,
    ...(placed.length ? ['Attachments:', ...placed.map((a) => `  ${a.name}: ${a.path}`)] : []),
  ];
  const body = `${scrubText(plan.body).text}\n${footer.join('\n')}\n`;
  const marker = `X-Folio-Copy: text copy${what ? `; removed ${what}` : ''}${held?.expires_at ? `; original held until ${held.expires_at.slice(0, 10)}` : ''}`;
  return `${headerText}\r\n${marker}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${body.replace(/\r?\n/g, '\r\n')}`;
}

/** Put bytes in the host's temporary storage. Returns { where: 'held', store, key, expires_at } or null. */
async function holdBytes(folio, bytes, meta) {
  if (!folio.hold || typeof folio.hold.put !== 'function') return null;
  const sha256 = meta.sha256 || [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const r = await folio.hold.put(bytes, { name: meta.name, type: meta.type || null, sha256, actor: meta.actor, via: meta.via });
  return r ? { where: 'held', ...r } : null;
}

function heldPhrase(stored, what) {
  if (stored?.where === 'held') return `${what} is held in temporary storage${stored.expires_at ? ` until ${stored.expires_at.slice(0, 10)}` : ''}`;
  return `${what} was not kept`;
}

function dataSentence(s) {
  const size = s.records === null ? s.format.replace(/_/g, ' ') : `${s.records.toLocaleString('en-US')} ${s.logs ? 'lines' : 'records'}${s.fields.length ? `, ${s.fields.length} fields` : ''}`;
  const pii = s.pii.found ? `; personal data (${s.pii.types.map((t) => t.toLowerCase().replace(/_/g, ' ')).join(', ')}) masked in the samples` : s.pii.unknown ? '; not read, so treated as personal data' : '';
  return `Summarised ${s.name} (${size}${pii}); ${heldPhrase(s.stored, 'the file itself')}`;
}

function describeRef(r) {
  const ref = r.reference;
  if (ref.kind === 'release') return `release ${ref.tag}`;
  if (ref.kind === 'pull') return `pull request #${ref.number}`;
  if (ref.kind === 'issue') return `issue #${ref.number}`;
  if (ref.kind === 'commit') return `commit ${String(ref.sha).slice(0, 7)}`;
  if (ref.kind === 'branch') return `branch ${ref.name}`;
  if (ref.kind === 'file') return `file ${ref.path}`;
  return ref.kind;
}

/**
 * Provenance for anything that is not otherwise attributed (spec 8.4): when, by whom and
 * how an item entered the folio. One small file per item under history/intake/.
 */
export async function writeIntakeRecord(folio, { actor, via, ...rest }) {
  const at = folio.now();
  const stamp = at.replace(/[-:]/g, '').replace(/\.\d+/, '').replace('Z', 'Z');
  const h = await shortHash(`${at}:${rest.path || rest.url}:${Math.random()}`);
  const body = { at, ...(actor ? { actor } : {}), via, ...rest };
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  await folio.fs.write(`history/intake/${stamp}-${h}.json`, json(body), { ifMatch: null });
}
