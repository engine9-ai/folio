import { validateRepositories } from './repositories.js';

export const FORMAT = 'folio';
export const FORMAT_REVISION = 1;
export const FOLIO_STATUSES = ['draft', 'active', 'waiting', 'completed', 'archived'];

const ID_ALPHABET = 'abcdefghjkmnpqrstvwxyz23456789';

export function newFolioId(random = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  const bytes = random(6);
  let s = '';
  for (const b of bytes) s += ID_ALPHABET[b % ID_ALPHABET.length];
  return `fol-${s}`;
}

export function createManifest({ title, id, summary, status = 'draft', now = new Date().toISOString(), ...rest }) {
  return {
    format: FORMAT,
    format_revision: FORMAT_REVISION,
    id: id || newFolioId(),
    title,
    ...(summary ? { summary } : {}),
    status,
    created_at: now,
    updated_at: now,
    ...rest,
  };
}

export function validateManifest(m) {
  const problems = [];
  const err = (code, message, path = 'folio.json') => problems.push({ level: 'error', code, path, message });
  if (!m || typeof m !== 'object' || Array.isArray(m)) {
    err('manifest_not_object', 'folio.json must be a JSON object');
    return problems;
  }
  if (m.format !== FORMAT) err('manifest_format', `format must be "${FORMAT}"`);
  if (!Number.isInteger(m.format_revision) || m.format_revision < 1) err('manifest_revision', 'format_revision must be a positive integer');
  else if (m.format_revision > FORMAT_REVISION)
    problems.push({ level: 'warning', code: 'manifest_newer_revision', path: 'folio.json', message: `Written by a newer format revision (${m.format_revision}); unknown fields will be preserved` });
  if (typeof m.id !== 'string' || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(m.id)) err('manifest_id', 'id must be a stable lowercase identifier');
  if (typeof m.title !== 'string' || !m.title.trim()) err('manifest_title', 'title is required');
  if (m.status !== undefined && !FOLIO_STATUSES.includes(m.status)) err('manifest_status', `status must be one of ${FOLIO_STATUSES.join(', ')}`);
  for (const k of ['created_at', 'updated_at']) {
    if (m[k] !== undefined && Number.isNaN(Date.parse(m[k]))) err('manifest_date', `${k} must be an ISO timestamp`);
  }
  if (m.tags !== undefined && (!Array.isArray(m.tags) || m.tags.some((t) => typeof t !== 'string'))) err('manifest_tags', 'tags must be an array of strings');
  if (m.connections !== undefined) {
    if (!Array.isArray(m.connections)) err('connections_not_array', 'connections must be an array');
    else
      m.connections.forEach((c, i) => {
        if (!c || typeof c.alias !== 'string' || typeof c.type !== 'string') err('connection_shape', 'connection needs type and alias', `folio.json#connections[${i}]`);
      });
  }
  problems.push(...validateRepositories(m.repositories));
  return problems;
}
