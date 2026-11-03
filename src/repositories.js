import { ValidationError } from './errors.js';

/**
 * Repository listing: a core part of a folio. A folio documents which git
 * repositories its work touches, in folio.json `repositories`. Every entry is a
 * reference: nothing here fetches anything, and an entry stays meaningful when
 * no integration is connected. Hosted services may add live state on top, but
 * that state never lives in the folio.
 */

export const REPOSITORY_PROVIDERS = ['github', 'gitlab', 'bitbucket', 'git'];
export const REPOSITORY_ROLES = ['primary', 'secondary', 'reference'];

const GITHUB_SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** Parse a GitHub URL (repo, branch, file, pull, issue, commit, release). Returns null if not GitHub. */
export function parseGithubUrl(input) {
  let u;
  try {
    u = new URL(input);
  } catch {
    return null;
  }
  if (u.hostname !== 'github.com' && u.hostname !== 'www.github.com') return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const repository = `${parts[0]}/${parts[1].replace(/\.git$/, '')}`;
  if (!GITHUB_SLUG.test(repository)) return null;
  const out = { provider: 'github', repository, url: `https://github.com/${repository}` };
  const [, , kind, a, ...rest] = parts;
  if (!kind) return out;
  if ((kind === 'pull' || kind === 'issues') && /^\d+$/.test(a || '')) out.ref = { kind: kind === 'pull' ? 'pull' : 'issue', number: Number(a) };
  else if (kind === 'commit' && a) out.ref = { kind: 'commit', sha: a };
  else if (kind === 'tree' && a) out.ref = { kind: 'branch', name: [a, ...rest].join('/') };
  else if (kind === 'blob' && a) out.ref = { kind: 'file', branch: a, path: rest.join('/') };
  else if (kind === 'releases' && a === 'tag' && rest[0]) out.ref = { kind: 'release', tag: rest.join('/') };
  return out;
}

/** Accepts "owner/name", a GitHub URL, a generic git URL, or an object. Returns a normalized entry. */
export function normalizeRepository(input, { now = new Date().toISOString() } = {}) {
  const obj = typeof input === 'string' ? (input.includes('://') ? { url: input } : { repository: input }) : { ...input };
  let provider = obj.provider;
  if (!provider && obj.url) provider = parseGithubUrl(obj.url) ? 'github' : 'git';
  if (!provider) provider = 'github';
  const out = { provider };
  if (provider === 'github') {
    const parsed = obj.url ? parseGithubUrl(obj.url) : null;
    out.repository = (obj.repository || parsed?.repository || '').replace(/\.git$/, '');
    out.url = obj.url && parsed ? parsed.url : out.repository ? `https://github.com/${out.repository}` : undefined;
  } else {
    if (obj.repository) out.repository = obj.repository;
    if (obj.url) out.url = obj.url;
  }
  for (const k of ['purpose', 'role', 'default_branch', 'branches', 'notes', 'added_by']) if (obj[k] !== undefined) out[k] = obj[k];
  out.added_at = obj.added_at || now;
  // Preserve unknown optional fields (spec 3.4: never discard what we don't understand).
  for (const [k, v] of Object.entries(obj)) if (!(k in out) && v !== undefined && !['ref'].includes(k)) out[k] = v;
  return out;
}

export function repositoryKey(r) {
  if (r.provider === 'github') return `github:${(r.repository || '').toLowerCase()}`;
  return `${r.provider}:${(r.url || r.repository || '').toLowerCase().replace(/\.git$/, '')}`;
}

export function validateRepositories(list) {
  const problems = [];
  if (list === undefined) return problems;
  if (!Array.isArray(list)) return [{ level: 'error', code: 'repositories_not_array', path: 'folio.json#repositories', message: 'repositories must be an array' }];
  const seen = new Map();
  list.forEach((r, i) => {
    const path = `folio.json#repositories[${i}]`;
    const err = (code, message) => problems.push({ level: 'error', code, path, message });
    if (!r || typeof r !== 'object') return err('repository_not_object', 'Repository entry must be an object');
    if (!REPOSITORY_PROVIDERS.includes(r.provider)) err('repository_provider', `provider must be one of ${REPOSITORY_PROVIDERS.join(', ')}`);
    if (r.provider === 'github' && !GITHUB_SLUG.test(r.repository || '')) err('repository_slug', 'GitHub repository must look like owner/name');
    if (r.provider !== 'github' && !r.url) err('repository_url', 'Non-GitHub repositories need a url');
    if (r.role !== undefined && !REPOSITORY_ROLES.includes(r.role)) err('repository_role', `role must be one of ${REPOSITORY_ROLES.join(', ')}`);
    if (r.url && /\/\/[^/@\s]+:[^/@\s]+@/.test(r.url)) err('repository_url_credentials', 'Repository URL must not embed credentials');
    const key = repositoryKey(r);
    if (seen.has(key)) problems.push({ level: 'warning', code: 'repository_duplicate', path, message: `Duplicate of repositories[${seen.get(key)}]` });
    else seen.set(key, i);
  });
  return problems;
}

/** Returns a new repositories array with the entry added. Throws on a duplicate or invalid entry. */
export function addRepositoryTo(list = [], input, opts) {
  const entry = normalizeRepository(input, opts);
  const problems = validateRepositories([entry]).filter((p) => p.level === 'error');
  if (problems.length) throw new ValidationError(problems);
  if (list.some((r) => repositoryKey(r) === repositoryKey(entry))) throw new ValidationError(`Repository ${entry.repository || entry.url} is already listed`);
  return [...list, entry];
}

export function removeRepositoryFrom(list = [], input) {
  const key = repositoryKey(normalizeRepository(input));
  return list.filter((r) => repositoryKey(r) !== key);
}

/** Library-level description. A library knows only references; hosted state is layered on by a service. */
export function describeRepository(r) {
  return { ...r, integration_state: 'reference_only' };
}
