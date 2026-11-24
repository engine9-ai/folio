import { NotFoundError, ValidationError } from './errors.js';
import { normalizePath } from './fs.js';

/**
 * The folio's Trash (SPEC 3.5): files and folders are moved to `.trash/` rather than deleted, as in a desktop file
 * manager, and can be put back until the Trash is emptied. Each thing moved there is one entry:
 *
 *   .trash/<id>/trash.json    { id, at, by, path, kind: "file" | "folder", files: [paths as they were] }
 *   .trash/<id>/files/<path>  the files themselves, under their old paths
 *
 * Some files are part of what a folio is and cannot be moved: folio.json and README.md at the top, task records
 * (tasks/, kept by the platform that ran them) and the Trash itself. Sub-folios inside are not files here: they are
 * archived or moved like any folio.
 */

export const TRASH_DIR = '.trash';
export const isTrashPath = (p) => String(p || '').replace(/^\/+/, '').startsWith(`${TRASH_DIR}/`);
export const MAX_TRASH_FILES = 2000;

/** Why a path cannot go to the Trash, or null. */
export function trashRefusal(path) {
  const p = normalizePath(path);
  if (!p) return 'Choose a file or folder';
  if (isTrashPath(p) || p === TRASH_DIR) return 'That is already in the Trash';
  if (p === 'folio.json') return 'folio.json is the folio itself: archive the folio instead';
  if (p === 'README.md') return 'README.md is the folio’s description: clear its text instead';
  if (p === 'tasks' || p.startsWith('tasks/')) return 'Task records are kept by the platform that ran them';
  return null;
}

const stamp = (iso) => String(iso).replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-');

async function copy(fs, from, to) {
  const src = typeof fs.readBytes === 'function' ? await fs.readBytes(from) : null;
  if (src) {
    await fs.write(to, src.bytes, { ...(src.contentType ? { contentType: src.contentType } : {}) });
    return true;
  }
  const t = await fs.read(from);
  if (!t) return false;
  await fs.write(to, t.text);
  return true;
}

/**
 * An email's record in comms/ goes to the Trash with the email itself and its attachments (not with data summaries,
 * which are items of their own), so putting it back brings all of it back.
 */
async function emailCompanions(fs, p, all) {
  if (!/^comms\/[^/]+\.email\.json$/.test(p)) return [];
  try {
    const m = JSON.parse((await fs.read(p))?.text || '{}');
    const want = [m.original?.path, ...(m.attachments || []).filter((a) => !a.data).map((a) => a.path)].filter(Boolean);
    return [...new Set(want)].filter((f) => all.includes(f) && f !== p);
  } catch {
    return [];
  }
}

/**
 * Move a file or folder (every file under it) to the Trash. Moving an email in comms/ takes the email itself and its
 * attachments with it. Returns the entry: { id, at, by, path, kind, files }.
 */
export async function moveToTrash(folio, path, { actor } = {}) {
  const p = normalizePath(path);
  const why = trashRefusal(p);
  if (why) throw new ValidationError(why);
  const fs = folio.fs;
  const all = await fs.list('');
  const isFile = all.includes(p);
  const files = isFile ? [p, ...(await emailCompanions(fs, p, all))] : all.filter((f) => f.startsWith(`${p}/`) && !isTrashPath(f));
  if (!files.length) throw new NotFoundError(p);
  for (const f of files) {
    const no = trashRefusal(f);
    if (no) throw new ValidationError(`${f}: ${no}`);
  }
  if (files.length > MAX_TRASH_FILES) throw new ValidationError(`That folder holds ${files.length} files, more than can be moved at once (${MAX_TRASH_FILES})`);
  const at = folio.now();
  const id = `${stamp(at)}-${Math.random().toString(36).slice(2, 6)}`;
  const entry = { id, at, by: actor?.on_behalf_of || actor?.id || null, path: p, kind: isFile ? 'file' : 'folder', files };
  for (const f of files) await copy(fs, f, `${TRASH_DIR}/${id}/files/${f}`);
  await fs.write(`${TRASH_DIR}/${id}/trash.json`, JSON.stringify(entry, null, 2) + '\n', { contentType: 'application/json' });
  for (const f of files) await fs.remove(f);
  return entry;
}

/** What is in the Trash, newest first: [{ id, at, by, path, kind, files }]. */
export async function listTrash(folio) {
  const out = [];
  for (const p of (await folio.fs.list(`${TRASH_DIR}/`)).filter((x) => /^\.trash\/[^/]+\/trash\.json$/.test(x))) {
    try {
      out.push(JSON.parse((await folio.fs.read(p)).text));
    } catch {
      /* skip a damaged entry */
    }
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

async function entry(folio, id) {
  const clean = String(id || '').trim();
  if (!/^[\w-]+$/.test(clean)) throw new ValidationError('Give the id of something in the Trash');
  const cur = await folio.fs.read(`${TRASH_DIR}/${clean}/trash.json`);
  if (!cur) throw new NotFoundError(`${TRASH_DIR}/${clean}`);
  return JSON.parse(cur.text);
}

/** A free path near `p`: "name 2.ext", "name 3.ext"... */
async function freePath(fs, p, taken) {
  if (!taken.has(p)) return p;
  const slash = p.lastIndexOf('/');
  const dir = slash >= 0 ? p.slice(0, slash + 1) : '';
  const name = p.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; n < 500; n++) {
    const q = `${dir}${stem} ${n}${ext}`;
    if (!taken.has(q)) return q;
  }
  throw new ValidationError(`No free name for ${p}`);
}

/**
 * Put something back where it was. A file whose place is taken again comes back as "name 2.ext"; a folder whose
 * name is taken comes back as "folder 2". Returns { id, restored: [paths], path }.
 */
export async function restoreFromTrash(folio, id, { actor } = {}) {
  const e = await entry(folio, id);
  const fs = folio.fs;
  const taken = new Set(await fs.list(''));
  let root = e.path;
  if (e.kind === 'folder' && [...taken].some((f) => f.startsWith(`${root}/`))) {
    for (let n = 2; n < 500; n++) {
      if (![...taken].some((f) => f.startsWith(`${e.path} ${n}/`))) {
        root = `${e.path} ${n}`;
        break;
      }
    }
  }
  const restored = [];
  for (const f of e.files) {
    const target = e.kind === 'folder' ? `${root}${f.slice(e.path.length)}` : await freePath(fs, f, taken);
    if (await copy(fs, `${TRASH_DIR}/${e.id}/files/${f}`, target)) {
      restored.push(target);
      taken.add(target);
    }
  }
  await purge(fs, e.id);
  void actor;
  return { id: e.id, path: e.kind === 'folder' ? root : restored[0], restored };
}

async function purge(fs, id) {
  for (const p of await fs.list(`${TRASH_DIR}/${id}/`)) await fs.remove(p);
}

/** Delete for good: one entry (`id`), or everything in the Trash. Returns { deleted: [ids] }. */
export async function emptyTrash(folio, id = null) {
  const ids = id ? [(await entry(folio, id)).id] : (await listTrash(folio)).map((e) => e.id);
  for (const i of ids) await purge(folio.fs, i);
  // Anything else left under .trash/ (a damaged entry) goes too when the whole Trash is emptied.
  if (!id) for (const p of await folio.fs.list(`${TRASH_DIR}/`)) await folio.fs.remove(p);
  return { deleted: ids };
}
