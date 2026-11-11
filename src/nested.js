import { FolioError } from './errors.js';
import { normalizePath } from './fs.js';

/**
 * Folders all the way down. A folder is a folio when it holds a folio.json. Folders group folios (a hosting
 * service's top-level folders are its accounts), and a folio can hold other folios in its own subfolders:
 *
 *   acme/                       a folder (no folio.json)
 *     website-refresh/          a folio
 *       folio.json
 *       phase-2/                a folio inside a folio
 *         folio.json
 *
 * A nested folio is its own record: the folio around it does not list, search, validate or write its files, so
 * each can be shared, moved or exported on its own. Folio's own directories (comms/, sources/, notes/, tasks/ ...) never
 * hold nested folios; a folio.json filed under them is just a file.
 */

/** Top-level directories that belong to a folio's own record and never hold nested folios. */
export const RESERVED_DIRS = Object.freeze(['comms', 'attachments', 'sources', 'notes', 'history', 'indexes', 'feedback', 'artifacts', 'decisions', 'integrations', 'samples', 'tasks']);

/** Can `dir` (folio-relative, e.g. "phase-2" or "work/phase-2") hold a nested folio? */
export function canHoldFolio(dir) {
  const clean = normalizePath(dir);
  return !RESERVED_DIRS.includes(clean.split('/')[0].toLowerCase());
}

/** Nested folios inside a folio, from its file list: the outermost directories (outside RESERVED_DIRS) holding a folio.json. */
export async function nestedFolioDirs(fs) {
  const dirs = (await fs.list())
    .filter((p) => p.endsWith('/folio.json'))
    .map((p) => p.slice(0, -'/folio.json'.length))
    .filter((d) => canHoldFolio(d))
    .sort((a, b) => a.length - b.length);
  const out = [];
  for (const d of dirs) if (!out.some((o) => d.startsWith(`${o}/`))) out.push(d);
  return out.sort();
}

/**
 * A FolioFs that hides some subfolders (nested folios): they are not listed, read as missing, and cannot be
 * written. Everything else passes through, including `listInfo` and `readBytes` when the inner store has them.
 */
export class ExcludingFs {
  constructor(inner, dirs = []) {
    this.inner = inner;
    this.dirs = [...new Set(dirs.map((d) => `${normalizePath(d)}/`))];
    if (typeof inner.readBytes === 'function') this.readBytes = async (path) => (this.hidden(path) ? null : inner.readBytes(path));
    if (typeof inner.listInfo === 'function') this.listInfo = async (prefix = '') => (await inner.listInfo(prefix)).filter((e) => !this.hidden(e.path));
  }

  hidden(path) {
    const p = normalizePath(path);
    return this.dirs.some((d) => p.startsWith(d) || `${p}/` === d);
  }

  guard(path) {
    if (this.hidden(path)) throw new FolioError('nested_folio', `${path} belongs to a folio inside this one. Open that folio to change it.`);
  }

  async read(path) {
    return this.hidden(path) ? null : this.inner.read(path);
  }

  async write(path, data, opts) {
    this.guard(path);
    return this.inner.write(path, data, opts);
  }

  async exists(path) {
    return this.hidden(path) ? false : this.inner.exists(path);
  }

  async list(prefix = '') {
    return (await this.inner.list(prefix)).filter((p) => !this.hidden(p));
  }

  async remove(path) {
    this.guard(path);
    return this.inner.remove(path);
  }
}
