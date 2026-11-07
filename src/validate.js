import { validateManifest } from './manifest.js';
import { findCycle, validateTicket } from './tickets.js';

import { findCredentials, prohibitedIn } from './privacy.js';
import { KEEP_LIMITS } from './data.js';

const TEXT_EXT = /\.(md|json|txt|eml|csv|tsv|jsonl|ndjson|log|html|css|js|xml|yaml|yml|ini|conf|env)$/i;
const DATA_EXT = /\.(csv|tsv|jsonl|ndjson|log|sql|xlsx?|parquet)$/i;
const CODE_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|cs|php|swift|c|cc|cpp|h|hpp|scala|sh|ps1|vue|svelte)$/i;
/** Where code is expected: samples and notes (GUIDE.md), artifacts (deliverables), the library's examples. */
const CODE_OK = /^(notes|samples|artifacts|examples)\/|\/samples?\//;
const CODE_LIMIT = 10;

/**
 * Validate a folio folder: manifest, tickets, relationships, references and
 * obvious secrets. Never throws for a bad folio; returns problems instead.
 * `ok` is false only when there is at least one error.
 */
export async function validateFolio(fs) {
  const problems = [];
  const add = (level, code, path, message) => problems.push({ level, code, path, message });

  // Manifest
  const mf = await fs.read('folio.json');
  if (!mf) add('error', 'missing_manifest', 'folio.json', 'folio.json is required');
  else {
    try {
      problems.push(...validateManifest(JSON.parse(mf.text)));
    } catch (e) {
      add('error', 'manifest_json', 'folio.json', `Not valid JSON: ${e.message}`);
    }
  }
  if (!(await fs.exists('README.md'))) add('error', 'missing_readme', 'README.md', 'README.md is required');

  // Tickets
  const files = await fs.list();
  const ticketIds = [...new Set(files.map((f) => /^tickets\/(TK-\d+)\//.exec(f)?.[1]).filter(Boolean))].sort();
  const tickets = [];
  for (const id of ticketIds) {
    const path = `tickets/${id}/ticket.json`;
    const cur = await fs.read(path);
    if (!cur) {
      add('error', 'ticket_missing_json', path, `${id} has files but no ticket.json`);
      continue;
    }
    let t;
    try {
      t = JSON.parse(cur.text);
    } catch (e) {
      add('error', 'ticket_json', path, `Not valid JSON: ${e.message}`);
      continue;
    }
    if (t.id !== id) add('error', 'ticket_id_mismatch', path, `Folder is ${id} but ticket.json says ${t.id}`);
    problems.push(...validateTicket(t, path));
    tickets.push(t);

    // Events: history written inside the folder. Edits made outside the application
    // cannot be attested, so a gap is a warning, never silently "audited".
    const evFiles = files.filter((f) => f.startsWith(`tickets/${id}/events/`) && f.endsWith('.json'));
    const revs = [];
    for (const ef of evFiles) {
      try {
        revs.push(JSON.parse((await fs.read(ef)).text).revision);
      } catch {
        add('warning', 'event_json', ef, 'Event file is not valid JSON');
      }
    }
    const maxRev = revs.length ? Math.max(...revs) : 0;
    if (Number.isInteger(t.revision)) {
      if (maxRev > t.revision) add('warning', 'uncommitted_event', path, `History records revision ${maxRev} but the ticket is at ${t.revision}`);
      if (t.revision > maxRev) add('warning', 'unattested_change', path, `Ticket is at revision ${t.revision} but history only covers ${maxRev}: changes may have been made outside the application`);
    }

    // Links to files inside the folio
    for (const l of t.links || []) {
      if (l && typeof l.path === 'string' && !(await fs.exists(l.path))) add('error', 'broken_reference', path, `Link target ${l.path} does not exist in this folio`);
    }
  }

  // Relationships
  const known = new Set(tickets.map((t) => t.id));
  for (const t of tickets) {
    for (const r of t.relationships || []) {
      if (r && r.target && !known.has(r.target)) add('error', 'broken_reference', `tickets/${t.id}/ticket.json`, `${t.id} ${r.type} ${r.target}, which does not exist`);
    }
  }
  for (const type of ['parent', 'blocked_by']) {
    const cycle = findCycle(tickets, type);
    if (cycle) add('error', 'relationship_cycle', 'tickets', `${type} loop: ${cycle.join(' → ')}`);
  }

  // Content policy (spec 3.7, GUIDE.md): no credentials, card, bank or SSN numbers; no full datasets; no codebases.
  const code = [];
  for (const path of files) {
    if (CODE_EXT.test(path) && !CODE_OK.test(path)) code.push(path);
    if (DATA_EXT.test(path) && !path.startsWith('sources/data/')) {
      const info = typeof fs.stat === 'function' ? await fs.stat(path).catch(() => null) : null;
      const size = info?.size ?? (await fs.read(path))?.text.length ?? 0;
      if (size > KEEP_LIMITS.bytes) add('warning', 'dataset_in_folio', path, `A ${Math.round(size / 1024)} KB data file. Keep a summary in the folio and the file in temporary storage (add it again to have it summarised).`);
    }
    if (!TEXT_EXT.test(path)) continue;
    const cur = await fs.read(path);
    if (!cur || cur.text.length > 2_000_000) continue;
    const creds = new Set(findCredentials(cur.text).map((c) => c.name));
    for (const name of creds) add('error', 'possible_secret', path, `Looks like a credential (${name}). Folios must not contain credentials; refer to the password manager entry instead.`);
    const found = prohibitedIn(cur.text);
    delete found.CREDENTIAL;
    const kinds = Object.keys(found).map((t) => ({ PAYMENT_CARD: 'a card number', IBAN: 'a bank account number', US_SSN: 'a Social Security number' })[t] || t);
    if (kinds.length) add('error', 'prohibited_content', path, `Contains ${kinds.join(', ')}. Folios must not hold payment, bank or Social Security numbers.`);
  }
  if (code.length >= CODE_LIMIT) add('warning', 'source_code', code[0], `${code.length} source files outside notes/ and samples/. Code belongs in a repository: list it in folio.json and reference releases, pull requests or commits.`);

  return { ok: !problems.some((p) => p.level === 'error'), problems };
}
