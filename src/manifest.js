import { validateRepositories } from './repositories.js';
import { validateCc } from './cc.js';
import { FOLIO_PRIORITIES, FOLIO_TYPES, RELATIONSHIP_TYPES, isFolioId } from './relations.js';

export const FORMAT = 'folio';
export const FORMAT_REVISION = 1;
/**
 * A folio's status is the most important thing about it after its title: it is the column a folio sits in on its
 * folder's board. The standard statuses, in board order. A folio may use another lowercase status of its own
 * ("blocked-on-legal"); boards show it as an extra column.
 */
export const FOLIO_STATUSES = ['draft', 'backlog', 'planned', 'active', 'waiting', 'review', 'completed', 'archived'];
export const FOLIO_STATUS_LABELS = Object.freeze({ draft: 'Draft', backlog: 'Backlog', planned: 'Up Next', active: 'In Progress', waiting: 'Waiting', review: 'In Review', completed: 'Done', archived: 'Archived' });
export const FOLIO_STATUS_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/;
/** "In Progress" for active; a custom status reads as its words ("blocked-on-legal" -> "Blocked on legal"). */
export const folioStatusLabel = (s) => FOLIO_STATUS_LABELS[s] || String(s || '').replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());

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
  if (m.status !== undefined) {
    if (typeof m.status !== 'string' || !FOLIO_STATUS_PATTERN.test(m.status)) err('manifest_status', `status must be a lowercase word such as ${FOLIO_STATUSES.join(', ')}`);
    else if (!FOLIO_STATUSES.includes(m.status))
      problems.push({ level: 'warning', code: 'manifest_custom_status', path: 'folio.json', message: `"${m.status}" is not a standard status (${FOLIO_STATUSES.join(', ')}); boards show it as its own column` });
  }
  for (const k of ['created_at', 'updated_at']) {
    if (m[k] !== undefined && Number.isNaN(Date.parse(m[k]))) err('manifest_date', `${k} must be an ISO timestamp`);
  }
  if (m.tags !== undefined && (!Array.isArray(m.tags) || m.tags.some((t) => typeof t !== 'string'))) err('manifest_tags', 'tags must be an array of strings');
  if (m.type !== undefined) {
    if (typeof m.type !== 'string' || !FOLIO_STATUS_PATTERN.test(m.type)) err('manifest_type', `type must be a lowercase word such as ${FOLIO_TYPES.join(', ')}`);
    else if (!FOLIO_TYPES.includes(m.type)) problems.push({ level: 'warning', code: 'manifest_custom_type', path: 'folio.json', message: `"${m.type}" is not a standard type (${FOLIO_TYPES.join(', ')})` });
  }
  if (m.priority !== undefined && !FOLIO_PRIORITIES.includes(m.priority)) err('manifest_priority', `priority must be one of ${FOLIO_PRIORITIES.join(', ')}`);
  if (m.target_date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(m.target_date))) err('manifest_target_date', 'target_date must be YYYY-MM-DD');
  if (m.aliases !== undefined && (!Array.isArray(m.aliases) || m.aliases.some((t) => typeof t !== 'string'))) err('manifest_aliases', 'aliases must be an array of strings');
  if (m.external !== undefined && (!m.external || typeof m.external !== 'object' || typeof m.external.source !== 'string' || typeof m.external.id !== 'string'))
    err('manifest_external', 'external must be { source, id } naming where the folio was imported from');
  if (m.links !== undefined && (!Array.isArray(m.links) || m.links.some((l) => !l || typeof l !== 'object' || (typeof l.url !== 'string' && typeof l.path !== 'string')))) err('manifest_links', 'links must be an array of { url } or { path }');
  if (m.relationships !== undefined) {
    if (!Array.isArray(m.relationships)) err('manifest_relationships', 'relationships must be an array');
    else
      m.relationships.forEach((r) => {
        if (!r || !RELATIONSHIP_TYPES.includes(r.type) || !isFolioId(r.target)) err('manifest_relationship', `invalid relationship ${JSON.stringify(r)}; types: ${RELATIONSHIP_TYPES.join(', ')}; targets are folio ids`);
        else if (r.target === m.id) err('manifest_self_reference', 'a folio cannot relate to itself');
      });
  }
  if (m.connections !== undefined) {
    if (!Array.isArray(m.connections)) err('connections_not_array', 'connections must be an array');
    else
      m.connections.forEach((c, i) => {
        if (!c || typeof c.alias !== 'string' || typeof c.type !== 'string') err('connection_shape', 'connection needs type and alias', `folio.json#connections[${i}]`);
      });
  }
  problems.push(...validateRepositories(m.repositories));
  problems.push(...validateCc(m.cc));
  return problems;
}
