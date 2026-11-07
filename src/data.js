import { CLASSIFIER_VERSION, RULES_VERSION, classify, maskValue, redactText, scanText } from '@engine9/pii-classifier';

/**
 * Summaries of data files and logs (GUIDE.md "Data files and logs", SPEC 8.4.1).
 *
 * A data export or a log is usually full of other people's personal data (members, customers, donors), and
 * is far larger than anyone needs to read in a folio. So the folio keeps a *summary*: what the file was, how
 * many records, which fields, a few sample values with personal data masked, and where the original is held
 * for a limited time. The bytes go to temporary storage provided by the host (R2 for folio-server, a local
 * folder for the CLI), never into the folio, unless the file is small and contains no personal data.
 *
 * Classification is @engine9/pii-classifier's: `classify` for each field from a sample of rows, `scanText`
 * and `redactText` for free text and log lines. Identifier fields (donor_id, customer_id) are kept as they
 * are; they identify a record, which is what support work needs, not a person.
 *
 * Large files are never decoded whole: records are counted over the bytes, and samples come from the head.
 */

export const SUMMARY_KIND = 'folio.data_summary';
export const SUMMARY_VERSION = 1;

/** A data file this small, with no personal data found, may stay in the folio as an ordinary file. */
export const KEEP_LIMITS = Object.freeze({ bytes: 64 * 1024, records: 50 });

const HEAD_BYTES = 1024 * 1024;
const TAIL_BYTES = 256 * 1024;
const JSON_PARSE_LIMIT = 8 * 1024 * 1024;
const CLASSIFY_ROWS = 64;
const MAX_FIELDS = 200;
const EXAMPLE_CHARS = 80;
const LOG_LINE_CHARS = 300;

const TABLE_EXT = { csv: 'csv', tsv: 'tsv', tab: 'tsv', psv: 'csv', json: 'json', jsonl: 'jsonl', ndjson: 'jsonl' };
const LOG_EXT = new Set(['log', 'out', 'err', 'trace']);
/** Data we can name but not read here: kept out of the folio, summarised by name, size and type only. */
const OPAQUE_EXT = { xlsx: 'spreadsheet', xls: 'spreadsheet', xlsm: 'spreadsheet', ods: 'spreadsheet', numbers: 'spreadsheet', parquet: 'parquet', avro: 'avro', orc: 'orc', sqlite: 'database', db: 'database', mdb: 'database', accdb: 'database', sav: 'statistics', dta: 'statistics', sql: 'sql_dump', bak: 'database_backup', dump: 'database_backup' };
const COMPRESSED = /\.(csv|tsv|json|jsonl|ndjson|log|sql|txt)\.(gz|zip|bz2|xz|zst)$/i;
const TABLE_TYPES = { 'text/csv': 'csv', 'text/tab-separated-values': 'tsv', 'application/x-ndjson': 'jsonl', 'application/jsonl': 'jsonl' };

const extOf = (name) => (/\.([a-z0-9]{1,10})$/i.exec(name || '')?.[1] || '').toLowerCase();
const decoder = () => new TextDecoder('utf-8', { fatal: false });
const head = (bytes, n = HEAD_BYTES) => decoder().decode(bytes.subarray(0, Math.min(bytes.length, n))).replace(/^﻿/, '');

/**
 * Is this a data file or a log? Returns { format, read } or null. `read` is 'table', 'log' or 'none'
 * (recognised, not readable here). Pure: looks only at the name, the type and the first bytes.
 */
export function dataFormat({ name = '', type = '', bytes } = {}) {
  const ext = extOf(name);
  const t = String(type || '').toLowerCase().split(';')[0].trim();
  if (COMPRESSED.test(name)) return { format: `compressed_${COMPRESSED.exec(name)[1].toLowerCase()}`, read: 'none' };
  if (OPAQUE_EXT[ext]) return { format: OPAQUE_EXT[ext], read: 'none' };
  if (t === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || t === 'application/vnd.ms-excel') return { format: 'spreadsheet', read: 'none' };
  const tableFormat = TABLE_EXT[ext] || TABLE_TYPES[t];
  if (tableFormat === 'json' || (!tableFormat && t === 'application/json')) {
    // Only JSON that is a list of records is data. A config or a single object is an ordinary file.
    return bytes && jsonLooksTabular(bytes) ? { format: 'json', read: 'table' } : null;
  }
  if (tableFormat) return { format: tableFormat, read: 'table' };
  if (LOG_EXT.has(ext)) return { format: 'log', read: 'log' };
  if (bytes && (!ext || ext === 'txt') && (t === '' || t.startsWith('text/'))) {
    const text = head(bytes, 64 * 1024);
    if (looksLikeLog(text)) return { format: 'log', read: 'log' };
  }
  return null;
}

function jsonLooksTabular(bytes) {
  const text = head(bytes, 4096).trimStart();
  if (text.startsWith('[')) return /^\[\s*\{/.test(text);
  if (!text.startsWith('{')) return false;
  if (bytes.length > JSON_PARSE_LIMIT) return false;
  try {
    return Boolean(recordsIn(JSON.parse(head(bytes, bytes.length)))?.records.length >= 2);
  } catch {
    return false;
  }
}

const TIMESTAMP = /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\[\d{2}\/[A-Z][a-z]{2}\/\d{4}:\d{2}:\d{2}:\d{2} [+-]\d{4}\]|\b[A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2}\b)/;
const LEVEL = /\b(TRACE|DEBUG|INFO|NOTICE|WARN(?:ING)?|ERROR|ERR|FATAL|CRIT(?:ICAL)?|ALERT|EMERG(?:ENCY)?)\b|"(?:level|severity)"\s*:\s*"(\w+)"/;

function looksLikeLog(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 200);
  if (lines.length < 10) return false;
  const stamped = lines.filter((l) => TIMESTAMP.test(l.slice(0, 64))).length;
  return stamped / lines.length >= 0.6;
}

async function sha256(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Summarise a data file or log. Never throws for bad content: an unreadable file still gets a summary of
 * what it was, with a note. `meta`: { name, type, submitted_at, submitted_by, via, sampleRows }.
 */
export async function summarizeData(bytes, meta = {}) {
  const fmt = dataFormat({ name: meta.name, type: meta.type, bytes }) || { format: 'unknown', read: 'none' };
  const summary = {
    kind: SUMMARY_KIND,
    version: SUMMARY_VERSION,
    name: meta.name || 'untitled',
    content_type: meta.type || null,
    format: fmt.format,
    size: bytes.byteLength,
    sha256: await sha256(bytes),
    submitted_at: meta.submitted_at || new Date().toISOString(),
    ...(meta.submitted_by ? { submitted_by: meta.submitted_by } : {}),
    ...(meta.via ? { via: meta.via } : {}),
    records: null,
    fields: [],
    sample: [],
    pii: { found: false, types: [], fields: [], classifier: `${CLASSIFIER_VERSION}/${RULES_VERSION}` },
    notes: [],
  };
  try {
    if (fmt.read === 'table') summarizeTable(bytes, fmt.format, summary, meta);
    else if (fmt.read === 'log') summarizeLog(bytes, summary, meta);
    else summary.notes.push(`${fmt.format.replace(/_/g, ' ')} files are not read here: only the name, size and type are recorded.`);
  } catch (e) {
    summary.notes.push(`Could not read the file as ${fmt.format}: ${e.message}`);
  }
  if (fmt.read === 'none' || summary.records === null) summary.pii.unknown = true; // unread: assume it may hold personal data
  return summary;
}

/** May this file stay in the folio as an ordinary file? Small, read, and no personal data found. */
export function keepInFolio(summary) {
  if (summary.pii.found || summary.pii.unknown) return false;
  if (summary.size > KEEP_LIMITS.bytes) return false;
  if (summary.logs) return true;
  return summary.records !== null && summary.records <= KEEP_LIMITS.records;
}

// ---- tables ----

function summarizeTable(bytes, format, summary, meta) {
  let rows; // array of { field: value }
  let columns;
  if (format === 'csv' || format === 'tsv') {
    const text = head(bytes);
    const delimiter = format === 'tsv' ? '\t' : sniffDelimiter(text);
    const parsed = parseDelimited(text, delimiter, bytes.length > HEAD_BYTES);
    if (!parsed.length) throw new Error('no rows');
    columns = uniqueNames(parsed[0]);
    rows = parsed.slice(1).map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? null])));
    summary.delimiter = delimiter === '\t' ? 'tab' : delimiter;
    summary.header = true;
    summary.records = Math.max(0, countDelimitedRows(bytes) - 1);
  } else if (format === 'jsonl') {
    const text = head(bytes);
    const lines = text.split(/\r?\n/);
    if (bytes.length > HEAD_BYTES) lines.pop(); // probably cut mid-record
    rows = [];
    let bad = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const v = JSON.parse(line);
        rows.push(v && typeof v === 'object' && !Array.isArray(v) ? flatten(v) : { value: v });
      } catch {
        bad += 1;
      }
    }
    if (bad) summary.notes.push(`${bad} line${bad === 1 ? '' : 's'} in the sampled part are not JSON.`);
    summary.records = countLines(bytes);
  } else {
    if (bytes.length <= JSON_PARSE_LIMIT) {
      const found = recordsIn(JSON.parse(head(bytes, bytes.length)));
      if (!found) throw new Error('no list of records');
      if (found.path) summary.records_path = found.path;
      rows = found.records.map((r) => (r && typeof r === 'object' && !Array.isArray(r) ? flatten(r) : { value: r }));
      summary.records = rows.length;
    } else {
      const streamed = streamJsonArray(bytes);
      rows = streamed.sample.map((r) => (r && typeof r === 'object' && !Array.isArray(r) ? flatten(r) : { value: r }));
      summary.records = streamed.count;
    }
  }
  columns ||= [...new Set(rows.slice(0, 500).flatMap((r) => Object.keys(r)))];
  if (columns.length > MAX_FIELDS) {
    summary.notes.push(`${columns.length} fields; the first ${MAX_FIELDS} are described.`);
    columns = columns.slice(0, MAX_FIELDS);
  }
  if (bytes.length > HEAD_BYTES) summary.notes.push(`Fields and samples come from the first ${Math.round(HEAD_BYTES / 1024)} KB; records are counted over the whole file.`);
  summary.sampled_records = rows.length;

  // Classify each field from up to CLASSIFY_ROWS rows spread through the sampled part.
  const step = Math.max(1, Math.floor(rows.length / CLASSIFY_ROWS));
  const picked = rows.filter((_, i) => i % step === 0).slice(0, CLASSIFY_ROWS);
  const result = classify({
    context: { assetId: summary.name, assetPath: summary.name.replace(/\.[^.]+$/, ''), sourceKind: format === 'csv' || format === 'tsv' ? 'csv' : 'json', siblingPaths: columns, sampling: { strategy: 'systematic', observedRows: picked.length, requestedRows: CLASSIFY_ROWS } },
    fields: columns.map((c) => ({ path: c, samples: picked.map((r, i) => ({ sampleId: String(i), value: scalar(r[c]) })) })),
  });
  const byPath = new Map(result.fields.map((f) => [f.path, f]));

  const piiTypes = new Set();
  summary.fields = columns.map((name) => {
    const values = rows.map((r) => r[name]);
    const present = values.filter((v) => v !== null && v !== undefined && String(v).trim() !== '');
    const f = byPath.get(name);
    const personal = (f?.findings || []).filter((x) => x.type !== 'PERSON_LINKED_ID' && (x.status === 'confirmed' || x.status === 'likely' || (x.status === 'possible' && f.outcome !== 'not_observed')));
    const isPersonal = personal.length > 0 && (f.outcome === 'pii_detected' || f.outcome === 'possible');
    const out = { name, type: inferType(present), empty: values.length - present.length };
    if (isPersonal) {
      const types = [...new Set(personal.map((x) => x.type))];
      types.forEach((t) => piiTypes.add(t));
      out.pii = { outcome: f.outcome, types };
      out.examples = [...new Set(personal.flatMap((x) => x.examples))].slice(0, 3);
      if (!out.examples.length) out.examples = ['[withheld]'];
      summary.pii.fields.push(name);
    } else {
      const ex = [];
      for (const v of present) {
        const shown = safeExample(v);
        if (!ex.includes(shown)) ex.push(shown);
        if (ex.length >= 3 || shown.length >= EXAMPLE_CHARS) break;
      }
      out.examples = ex;
      if ((f?.findings || []).some((x) => x.type === 'PERSON_LINKED_ID')) out.identifier = true;
    }
    return out;
  });
  summary.pii.types = [...piiTypes].sort();
  summary.pii.found = piiTypes.size > 0;

  const masks = new Map(summary.fields.filter((f) => f.pii).map((f) => [f.name, f.pii.types[0]]));
  summary.sample = rows.slice(0, meta.sampleRows ?? 5).map((r) =>
    Object.fromEntries(columns.map((c) => {
      const v = r[c];
      if (v === null || v === undefined || String(v).trim() === '') return [c, v ?? null];
      return [c, masks.has(c) ? maskPersonal(masks.get(c), v) : safeExample(v)];
    }))
  );
  // Personal data that sits inside otherwise ordinary fields (a "notes" column) was redacted from examples.
}

/**
 * A value from a personal-data field. Free text with personal data inside it ("Called; my name is Ana") keeps
 * its words with the personal parts redacted; a value that *is* the personal data is masked whole.
 */
function maskPersonal(type, v) {
  const s = String(typeof v === 'string' ? v : JSON.stringify(v)).trim();
  const r = redactText(s.length > 400 ? s.slice(0, 400) : s, { keepSynthetic: false });
  const whole = r.total === 1 && r.text.split(/\s+/).length <= 2;
  if (r.total && !whole) return r.text.length > EXAMPLE_CHARS ? r.text.slice(0, EXAMPLE_CHARS - 1) + '…' : r.text;
  return maskValue(type, s);
}

/** Example values are redacted for every personal-data type and kept short. */
function safeExample(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  const r = redactText(s.length > 400 ? s.slice(0, 400) : s, { keepSynthetic: true });
  return r.text.length > EXAMPLE_CHARS ? r.text.slice(0, EXAMPLE_CHARS - 1) + '…' : r.text;
}

const scalar = (v) => (v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : v);

function inferType(values) {
  if (!values.length) return 'empty';
  const sample = values.slice(0, 200).map((v) => (typeof v === 'string' ? v.trim() : v));
  const all = (fn) => sample.every(fn);
  if (all((v) => typeof v === 'boolean' || /^(true|false|yes|no|y|n)$/i.test(String(v)))) return 'boolean';
  if (all((v) => /^-?\d+$/.test(String(v)))) return 'integer';
  if (all((v) => /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(String(v)) || /^-?\$?\d{1,3}(,\d{3})*(\.\d+)?$/.test(String(v)))) return 'number';
  if (all((v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v)) || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(String(v)))) return 'date';
  if (all((v) => /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(String(v)))) return 'datetime';
  if (all((v) => typeof v === 'object')) return 'object';
  return 'string';
}

function uniqueNames(header) {
  const seen = new Map();
  return header.map((h, i) => {
    let name = String(h ?? '').trim() || `column_${i + 1}`;
    const n = seen.get(name) || 0;
    seen.set(name, n + 1);
    return n ? `${name}_${n + 1}` : name;
  });
}

function sniffDelimiter(text) {
  const first = text.split(/\r?\n/, 1)[0];
  const counts = [',', ';', '\t', '|'].map((d) => [d, first.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

/** RFC 4180 rows (quotes, doubled quotes, newlines inside quotes). `partial`: drop a last row cut off mid-way. */
export function parseDelimited(text, delimiter = ',', partial = false) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
    i += 1;
  }
  if (!partial && (field !== '' || row.length)) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return rows;
}

/** Rows over the whole file, without decoding it: newlines outside double quotes, plus a last unterminated row. */
function countDelimitedRows(bytes) {
  let rows = 0;
  let quoted = false;
  let content = false;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x22) quoted = !quoted;
    else if (b === 0x0a && !quoted) {
      if (content) rows += 1;
      content = false;
      continue;
    }
    if (b !== 0x0d && b !== 0x0a) content = true;
  }
  return rows + (content ? 1 : 0);
}

function countLines(bytes) {
  let lines = 0;
  let content = false;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x0a) {
      if (content) lines += 1;
      content = false;
    } else if (b !== 0x0d && b !== 0x20 && b !== 0x09) content = true;
  }
  return lines + (content ? 1 : 0);
}

/** A list of records in parsed JSON: the value itself, or the first array of objects one or two levels down. */
function recordsIn(v, path = '') {
  if (Array.isArray(v)) return v.length && v.some((x) => x && typeof x === 'object' && !Array.isArray(x)) ? { records: v, path: path || null } : null;
  if (!v || typeof v !== 'object' || path.split('.').length > 2) return null;
  for (const [k, x] of Object.entries(v)) {
    const found = recordsIn(x, path ? `${path}.${k}` : k);
    if (found) return found;
  }
  return null;
}

/** One level of nesting becomes dotted names; deeper values and arrays are kept as JSON. */
function flatten(obj, prefix = '', out = {}, depth = 0) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && depth < 1) flatten(v, key, out, depth + 1);
    else out[key] = v;
  }
  return out;
}

/** A top-level JSON array too large to parse: count its elements over the bytes, parse the first few. */
function streamJsonArray(bytes) {
  let depth = 0;
  let inString = false;
  let escape = false;
  let count = 0;
  let started = false;
  let elementStart = -1;
  let sawValue = false;
  const sample = [];
  const dec = decoder();
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (inString) {
      if (escape) escape = false;
      else if (b === 0x5c) escape = true;
      else if (b === 0x22) inString = false;
      continue;
    }
    if (b === 0x22) {
      inString = true;
      if (depth === 1) sawValue = true;
      continue;
    }
    if (b === 0x5b || b === 0x7b) {
      if (!started) {
        if (b !== 0x5b) throw new Error('not a JSON list');
        started = true;
        depth = 1;
        elementStart = i + 1;
        continue;
      }
      depth += 1;
      if (depth === 2) sawValue = true;
    } else if (b === 0x5d || b === 0x7d) {
      depth -= 1;
      if (depth === 0) {
        if (sawValue) {
          count += 1;
          if (sample.length < 200 && i - elementStart < 1 << 20) pushSample(i);
        }
        break;
      }
    } else if (b === 0x2c && depth === 1) {
      count += 1;
      if (sample.length < 200 && elementStart < HEAD_BYTES) pushSample(i);
      elementStart = i + 1;
      sawValue = false;
    } else if (depth === 1 && b > 0x20) sawValue = true;
  }
  function pushSample(end) {
    try {
      sample.push(JSON.parse(dec.decode(bytes.subarray(elementStart, end))));
    } catch {
      /* skip */
    }
  }
  return { count, sample };
}

// ---- logs ----

function summarizeLog(bytes, summary, meta) {
  const whole = bytes.length <= HEAD_BYTES + TAIL_BYTES;
  const first = head(bytes);
  const last = whole ? first : decoder().decode(bytes.subarray(bytes.length - TAIL_BYTES));
  const headLines = first.split(/\r?\n/);
  if (!whole) headLines.pop();
  const tailLines = last.split(/\r?\n/);
  if (!whole) tailLines.shift();
  const nonEmpty = (l) => l.trim() !== '';
  const levels = {};
  for (const l of headLines) {
    const m = LEVEL.exec(l);
    if (!m) continue;
    const lv = normLevel(m[1] || m[2]);
    if (lv) levels[lv] = (levels[lv] || 0) + 1;
  }
  const stamp = (lines, fromEnd) => {
    const list = fromEnd ? [...lines].reverse() : lines;
    for (const l of list) {
      const m = TIMESTAMP.exec(l.slice(0, 64));
      if (m) return m[1].replace(/^\[|\]$/g, '');
    }
    return null;
  };
  const scan = scanText(first, { maxChars: HEAD_BYTES });
  const pii = { ...scan.counts };
  const line = (l) => {
    const r = redactText(l.length > LOG_LINE_CHARS ? l.slice(0, LOG_LINE_CHARS) + '…' : l, { keepSynthetic: true });
    return r.text;
  };
  const errors = headLines.filter((l) => /\b(ERROR|ERR|FATAL|CRIT(?:ICAL)?|EMERG)\b|"(?:level|severity)"\s*:\s*"(?:error|fatal|critical)"/i.test(l)).slice(0, 5);
  summary.records = countLines(bytes);
  summary.logs = {
    lines: summary.records,
    first_at: stamp(headLines, false),
    last_at: stamp(tailLines, true),
    levels,
    pii_in_sampled_part: pii,
  };
  summary.sample = {
    first: headLines.filter(nonEmpty).slice(0, meta.sampleRows ?? 5).map(line),
    errors: errors.map(line),
    last: whole ? [] : tailLines.filter(nonEmpty).slice(-3).map(line),
  };
  if (!whole) summary.notes.push(`Levels and personal-data counts come from the first ${Math.round(HEAD_BYTES / 1024)} KB; lines are counted over the whole file.`);
  const types = Object.keys(pii).sort();
  summary.pii.types = types;
  summary.pii.found = types.length > 0;
}

function normLevel(raw) {
  const v = String(raw || '').toUpperCase();
  if (v === 'WARNING') return 'WARN';
  if (v === 'ERR') return 'ERROR';
  if (v === 'CRITICAL') return 'CRIT';
  if (v === 'EMERGENCY') return 'EMERG';
  return v || null;
}
