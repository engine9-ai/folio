import { promises as fsp } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { ConflictError, FolioError } from './errors.js';
import { normalizePath } from './fs.js';

const etagOf = (text) => createHash('sha256').update(text).digest('hex');

/**
 * FolioFs over a local directory (the folio folder itself).
 * Note: overwrite-with-etag is check-then-write, so it is safe against other
 * Folio calls in one process but not against another process writing in the
 * gap. Create-only writes are atomic (O_EXCL).
 */
export class NodeFs {
  constructor(root) {
    this.root = resolve(root);
  }

  abs(path) {
    const rel = normalizePath(path);
    const full = resolve(this.root, rel);
    if (full !== this.root && !full.startsWith(this.root + sep)) throw new FolioError('bad_path', `Path escapes folio: ${path}`);
    return full;
  }

  async read(path) {
    try {
      const buf = await fsp.readFile(this.abs(path));
      return { text: buf.toString('utf8'), etag: etagOf(buf) }; // same etag as readBytes and write
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'EISDIR') return null;
      throw e;
    }
  }

  async readBytes(path) {
    try {
      const bytes = new Uint8Array(await fsp.readFile(this.abs(path)));
      return { bytes, etag: etagOf(bytes) };
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'EISDIR') return null;
      throw e;
    }
  }

  /** `text` may be a string (UTF-8) or a Uint8Array. */
  async write(path, text, { ifMatch } = {}) {
    const full = this.abs(path);
    await fsp.mkdir(dirname(full), { recursive: true });
    if (ifMatch === null) {
      try {
        await fsp.writeFile(full, text, { flag: 'wx' });
      } catch (e) {
        if (e.code === 'EEXIST') throw new ConflictError(path, `${path} already exists`);
        throw e;
      }
      return { etag: etagOf(text) };
    }
    if (typeof ifMatch === 'string') {
      const cur = await this.read(path);
      if (!cur || cur.etag !== ifMatch) throw new ConflictError(path);
    }
    await fsp.writeFile(full, text);
    return { etag: etagOf(text) };
  }

  async exists(path) {
    try {
      await fsp.access(this.abs(path));
      return true;
    } catch {
      return false;
    }
  }

  async list(prefix = '') {
    const out = [];
    const walk = async (dir, rel) => {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch (e) {
        if (e.code === 'ENOENT') return;
        throw e;
      }
      for (const ent of entries) {
        const r = rel ? `${rel}/${ent.name}` : ent.name;
        if (ent.isDirectory()) await walk(join(dir, ent.name), r);
        else if (ent.isFile()) out.push(r);
      }
    };
    await walk(this.root, '');
    const pre = prefix ? prefix.split('/').filter(Boolean).join('/') + '/' : '';
    return out.filter((p) => p.startsWith(pre)).sort();
  }

  async remove(path) {
    await fsp.rm(this.abs(path), { force: true });
  }
}
