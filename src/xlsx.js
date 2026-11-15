/**
 * Reading .xlsx / .xlsm workbooks without a dependency (SPEC 8.4.1): a workbook is a zip of XML parts. Only what a
 * summary needs is read: sheet names, every row's cell text, and the range each sheet claims. Formulas come back
 * as their cached values, dates as Excel serial numbers (noted), styles and charts are ignored.
 *
 * Runs wherever DecompressionStream does (Workers, Node 18+, browsers). Sizes come from the zip's directory and
 * are capped, so a small file that inflates to gigabytes is refused, not unpacked.
 */

const MAX_PART = 40 * 1024 * 1024; // inflated bytes of one part
const MAX_TOTAL = 120 * 1024 * 1024;

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** The entries of a zip: Map of name -> { method, csize, usize, offset }. Throws when it is not a zip. */
export function zipEntries(bytes) {
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (u32(bytes, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = u16(bytes, eocd + 10);
  let p = u32(bytes, eocd + 16);
  const out = new Map();
  for (let n = 0; n < count; n++) {
    if (u32(bytes, p) !== 0x02014b50) throw new Error('damaged zip directory');
    const method = u16(bytes, p + 10);
    const csize = u32(bytes, p + 20);
    const usize = u32(bytes, p + 24);
    const nameLen = u16(bytes, p + 28);
    const extraLen = u16(bytes, p + 30);
    const commentLen = u16(bytes, p + 32);
    const offset = u32(bytes, p + 42);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    out.set(name, { method, csize, usize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function inflateRaw(data, limit) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new Error('a part of the workbook is too large to read');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** One zip entry's bytes, or null when it is not there. */
export async function zipRead(bytes, entries, name) {
  const e = entries.get(name);
  if (!e) return null;
  if (e.usize > MAX_PART) throw new Error(`${name} is too large to read (${Math.round(e.usize / 1048576)} MB)`);
  const p = e.offset;
  if (u32(bytes, p) !== 0x04034b50) throw new Error('damaged zip entry');
  const start = p + 30 + u16(bytes, p + 26) + u16(bytes, p + 28);
  const data = bytes.subarray(start, start + e.csize);
  if (e.method === 0) return data;
  if (e.method === 8) return inflateRaw(data, MAX_PART);
  throw new Error(`unsupported zip compression (${e.method})`);
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const unxml = (s) =>
  String(s || '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });

const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`).exec(tag) || new RegExp(`\\s${name}\\s*=\\s*'([^']*)'`).exec(tag);
  return m ? unxml(m[1]) : null;
};

/** Text of the <t> runs inside an element (shared strings, inline strings), joined. */
const runsText = (xml) => {
  let out = '';
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g;
  let m;
  while ((m = re.exec(xml))) out += m[1] ? unxml(m[1]) : '';
  return out;
};

/** "AB12" -> column index 27 (0-based). */
const colIndex = (ref) => {
  const letters = /^[A-Z]+/i.exec(ref || '')?.[0]?.toUpperCase() || '';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

const dimensionRows = (ref) => {
  const m = /^[A-Z]+(\d+)(?::[A-Z]+(\d+))?$/i.exec(String(ref || ''));
  if (!m) return null;
  return m[2] ? Number(m[2]) - Number(m[1]) + 1 : 1;
};

/**
 * Read a workbook: { sheets: [{ name, dimension, claimed_rows, rows: [[cell text]], row_count, hidden }],
 * notes }. `rows` holds the non-empty rows (at most `maxRows` per sheet); `row_count` counts every non-empty row.
 */
export async function readWorkbook(bytes, { maxRows = 5000, maxCols = 200, maxCell = 2000 } = {}) {
  const entries = zipEntries(bytes);
  let total = 0;
  for (const e of entries.values()) total += e.usize;
  if (total > MAX_TOTAL) throw new Error(`the workbook unpacks to ${Math.round(total / 1048576)} MB, more than Folio reads`);
  const text = async (name) => {
    const b = await zipRead(bytes, entries, name);
    return b ? new TextDecoder().decode(b) : null;
  };
  const workbook = await text('xl/workbook.xml');
  if (!workbook) throw new Error('no xl/workbook.xml: not an Excel workbook');
  const rels = (await text('xl/_rels/workbook.xml.rels')) || '';
  const targets = new Map();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id');
    let target = attr(m[0], 'Target') || '';
    target = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    targets.set(id, target.replace(/\/\.\//g, '/'));
  }
  const shared = [];
  const sst = await text('xl/sharedStrings.xml');
  if (sst) for (const m of sst.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\s*\/>/g)) shared.push(m[1] ? runsText(m[1]) : '');
  const notes = [];
  const sheets = [];
  let sawDates = false;
  for (const m of workbook.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const name = attr(m[0], 'name') || `Sheet${sheets.length + 1}`;
    const rid = attr(m[0], 'r:id') || attr(m[0], 'id');
    const hidden = /hidden/i.test(attr(m[0], 'state') || '');
    const part = targets.get(rid);
    const xml = part ? await text(part) : null;
    if (!xml) {
      sheets.push({ name, hidden, dimension: null, claimed_rows: null, rows: [], row_count: 0, note: 'not a worksheet (a chart or macro sheet)' });
      continue;
    }
    const dim = /<dimension\b[^>]*>/.exec(xml);
    const dimension = dim ? attr(dim[0], 'ref') : null;
    const rows = [];
    let count = 0;
    let truncatedCells = false;
    for (const r of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      if (!r[1]) continue;
      const cells = [];
      let any = false;
      for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const tag = ` ${c[1]}`;
        const ref = attr(tag, 'r');
        const i = ref ? colIndex(ref) : cells.length;
        if (i < 0 || i >= maxCols) continue;
        const t = attr(tag, 't');
        const body = c[2] || '';
        let v = '';
        if (t === 'inlineStr') v = runsText(body);
        else {
          const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
          if (raw === undefined) v = '';
          else if (t === 's') v = shared[Number(raw)] ?? '';
          else if (t === 'b') v = raw === '1' ? 'TRUE' : 'FALSE';
          else v = unxml(raw);
          if (!t && attr(tag, 's') && /^\d{5}(\.\d+)?$/.test(v)) sawDates = true;
        }
        if (v.length > maxCell) {
          v = v.slice(0, maxCell - 1) + '…';
          truncatedCells = true;
        }
        while (cells.length < i) cells.push('');
        cells[i] = v;
        if (v.trim() !== '') any = true;
      }
      if (!any) continue;
      count += 1;
      if (rows.length < maxRows) {
        while (cells.length && String(cells[cells.length - 1]).trim() === '') cells.pop();
        rows.push(cells);
      }
    }
    sheets.push({ name, hidden, dimension, claimed_rows: dimensionRows(dimension), rows, row_count: count, ...(truncatedCells ? { note: `long cells cut at ${maxCell} characters` } : {}) });
  }
  if (sawDates) notes.push('Some numbers may be dates (Excel keeps them as day counts from 1900).');
  return { sheets, notes };
}
