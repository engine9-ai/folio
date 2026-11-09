import { validateManifest } from './manifest.js';

import { findCredentials, prohibitedIn } from './privacy.js';
import { KEEP_LIMITS } from './data.js';

const TEXT_EXT = /\.(md|json|txt|eml|csv|tsv|jsonl|ndjson|log|html|css|js|xml|yaml|yml|ini|conf|env)$/i;
const DATA_EXT = /\.(csv|tsv|jsonl|ndjson|log|sql|xlsx?|parquet)$/i;
const CODE_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|cs|php|swift|c|cc|cpp|h|hpp|scala|sh|ps1|vue|svelte)$/i;
/** Where code is expected: samples and notes (GUIDE.md), artifacts (deliverables), the library's examples. */
const CODE_OK = /^(notes|samples|artifacts|examples)\/|\/samples?\//;
const CODE_LIMIT = 10;

/**
 * Validate a folio folder: manifest, messages, references and
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

  const files = await fs.list();

  // Messages in comms/ must be readable.
  for (const path of files.filter((f) => /^comms\/[^/]+\.(comment|update|agent|chat)\.json$/.test(f))) {
    try {
      const m = JSON.parse((await fs.read(path)).text);
      if (typeof m.text !== 'string' || Number.isNaN(Date.parse(m.at))) add('warning', 'message_shape', path, 'A message needs "at" (a timestamp) and "text"');
    } catch (e) {
      add('error', 'message_json', path, `Not valid JSON: ${e.message}`);
    }
  }
  if (files.some((f) => f.startsWith('tickets/'))) add('warning', 'legacy_tickets', 'tickets', 'This folio still has tickets from an earlier version. upgradeLayout() turns each into a folio inside this one.');

  // Links in folio.json to files inside the folio
  try {
    const m = mf ? JSON.parse(mf.text) : {};
    for (const l of m.links || []) if (l && typeof l.path === 'string' && !(await fs.exists(l.path))) add('error', 'broken_reference', 'folio.json', `Link target ${l.path} does not exist in this folio`);
  } catch {
    /* reported above */
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
