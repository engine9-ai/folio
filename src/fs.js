import { ConflictError, FolioError } from './errors.js';

/**
 * FolioFs is the storage port. A folio never touches a disk or bucket directly,
 * so the same code runs on a local folder, in memory, or on R2.
 *
 *   read(path)                -> { text, etag } | null      (UTF-8 text)
 *   readBytes(path)           -> { bytes, etag } | null     (optional; original bytes)
 *   write(path, data, opts)   -> { etag }
 *       data: a string (written as UTF-8) or a Uint8Array (written as is)
 *       opts.ifMatch: undefined = overwrite, null = create only, string = etag must match
 *       opts.contentType: optional media type, for stores that keep one
 *   exists(path)              -> boolean
 *   list(prefix = '')         -> sorted array of file paths below prefix (recursive)
 *   remove(path)              -> void
 *
 * Paths are folio-relative with forward slashes.
 */

export function normalizePath(path) {
  if (typeof path !== 'string' || path === '') throw new FolioError('bad_path', 'Path must be a non-empty string');
  if (path.includes('\\') || path.includes('\0')) throw new FolioError('bad_path', `Unsafe path: ${path}`);
  if (path.startsWith('/')) throw new FolioError('bad_path', `Path must be relative: ${path}`);
  const parts = path.split('/').filter((p) => p !== '');
  if (parts.length === 0) throw new FolioError('bad_path', 'Empty path');
  if (parts.some((p) => p === '.' || p === '..')) throw new FolioError('bad_path', `Path may not contain . or ..: ${path}`);
  return parts.join('/');
}

function normalizePrefix(prefix) {
  if (!prefix) return '';
  const parts = String(prefix).split('/').filter((p) => p !== '');
  if (parts.some((p) => p === '.' || p === '..')) throw new FolioError('bad_path', `Unsafe prefix: ${prefix}`);
  return parts.length ? parts.join('/') + '/' : '';
}

export class MemoryFs {
  constructor(files = {}) {
    this.files = new Map();
    this.counter = 0;
    for (const [path, text] of Object.entries(files)) {
      this.files.set(normalizePath(path), { text, etag: `v${++this.counter}` });
    }
  }

  async read(path) {
    const f = this.files.get(normalizePath(path));
    return f ? { text: typeof f.text === 'string' ? f.text : new TextDecoder().decode(f.text), etag: f.etag } : null;
  }

  async readBytes(path) {
    const f = this.files.get(normalizePath(path));
    return f ? { bytes: typeof f.text === 'string' ? new TextEncoder().encode(f.text) : f.text, etag: f.etag } : null;
  }

  async write(path, text, { ifMatch } = {}) {
    const p = normalizePath(path);
    const current = this.files.get(p);
    if (ifMatch === null && current) throw new ConflictError(p, `${p} already exists`);
    if (typeof ifMatch === 'string' && (!current || current.etag !== ifMatch)) throw new ConflictError(p);
    const etag = `v${++this.counter}`;
    this.files.set(p, { text: typeof text === 'string' ? text : new Uint8Array(text), etag });
    return { etag };
  }

  async exists(path) {
    return this.files.has(normalizePath(path));
  }

  async list(prefix = '') {
    const pre = normalizePrefix(prefix);
    return [...this.files.keys()].filter((k) => k.startsWith(pre)).sort();
  }

  async remove(path) {
    this.files.delete(normalizePath(path));
  }
}

/**
 * A FolioFs for one subfolder of another: a folio inside a folio is opened through one of these, so it sees only
 * its own files with paths relative to itself.
 */
export class SubFs {
  constructor(inner, dir) {
    this.inner = inner;
    this.dir = normalizePath(dir);
    const p = (path) => `${this.dir}/${normalizePath(path)}`;
    this.path = p;
    if (typeof inner.readBytes === 'function') this.readBytes = (path) => inner.readBytes(p(path));
    if (typeof inner.listInfo === 'function') this.listInfo = async (prefix = '') => (await inner.listInfo(prefix ? `${this.dir}/${normalizePrefix(prefix)}` : `${this.dir}/`)).map((e) => ({ ...e, path: e.path.slice(this.dir.length + 1) }));
  }
  read(path) {
    return this.inner.read(this.path(path));
  }
  write(path, data, opts) {
    return this.inner.write(this.path(path), data, opts);
  }
  exists(path) {
    return this.inner.exists(this.path(path));
  }
  async list(prefix = '') {
    const pre = `${this.dir}/${normalizePrefix(prefix)}`;
    return (await this.inner.list(pre)).map((p) => p.slice(this.dir.length + 1));
  }
  remove(path) {
    return this.inner.remove(this.path(path));
  }
}
