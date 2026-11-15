import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Folio, MemoryFs, dataFormat, summarizeData } from '../src/index.js';

const fixture = (n) => new Uint8Array(readFileSync(new URL(`./fixtures/${n}.xlsx`, import.meta.url)));
const now = () => '2026-11-11T02:00:00.000Z';
const actor = { type: 'user', id: 'chris@engine9.ai' };
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Temporary storage that remembers what it held. */
const hold = () => {
  const got = [];
  return { got, put: async (bytes, meta) => (got.push(meta), { where: 'test', key: `k${got.length}`, expires_at: '2026-12-11T00:00:00.000Z' }) };
};

test('workbooks are read: sheets, headers, rows that hold data, and whole sheets without personal data', async () => {
  assert.deepEqual(dataFormat({ name: 'a.xlsx' }), { format: 'spreadsheet', read: 'workbook' });
  assert.deepEqual(dataFormat({ name: 'a', type: XLSX }), { format: 'spreadsheet', read: 'workbook' });
  assert.deepEqual(dataFormat({ name: 'a.xls' }), { format: 'spreadsheet', read: 'none' });
  for (const n of ['layout-shared-strings', 'layout-inline']) {
    const s = await summarizeData(fixture(n), { name: 'HFHI Input and Output File Layout.xlsx' });
    assert.equal(s.pii.found, false, n);
    assert.equal(s.pii.unknown, undefined);
    assert.deepEqual(s.sheets.map((x) => [x.name, x.rows, x.data_rows]), [['Input Layout', 6, 5], ['Output Layout', 3, 2]]);
    assert.deepEqual(s.sheets[0].header, ['Field Name', 'Start', 'Length', 'Type', 'Transformation']);
    assert.deepEqual(s.sheets[0].content[4], ['GIFT_DATE', '31', '8', 'Date', 'YYYYMMDD -> MM/DD/YYYY']);
    assert.equal(s.records, 7);
  }
  const inline = await summarizeData(fixture('layout-inline'), { name: 'x.xlsx' });
  assert.match(inline.sheets[0].note, /claims 3,433 rows .* but 6 hold data/);
});

test('a sample spreadsheet with personal data is masked and held; a layout is kept with its readable summary', async () => {
  const h = hold();
  const fs = new MemoryFs();
  await Folio.init(fs, { title: 'Pipeline', now, actor });
  const folio = new Folio(fs, { now, hold: h });
  const [layout] = await folio.add({ name: 'HFHI Layout.xlsx', type: XLSX, data: fixture('layout-shared-strings') }, { actor });
  assert.equal(layout.kind, 'data');
  assert.match(layout.file, /^attachments\/HFHI Layout\.xlsx$/);
  const summary = JSON.parse((await folio.fs.read(layout.path)).text);
  assert.deepEqual(summary.stored, { where: 'folio', path: layout.file });
  assert.equal(summary.sheets[0].content.length, 6);
  assert.equal(h.got.length, 0, 'nothing held');
  const [samples] = await folio.add({ name: 'HFHI October Samples Scrubbed.xlsx', type: XLSX, data: fixture('samples') }, { actor });
  assert.equal(h.got.length, 1);
  const s = JSON.parse((await folio.fs.read(samples.path)).text);
  assert.equal(s.pii.found, true);
  assert.equal(s.sheets[0].content, undefined, 'never whole when it holds personal data');
  assert.equal(s.sheets[0].sample[0].EMAIL, 'm***@***.com');
  assert.equal(s.sheets[0].sample[0].DONOR_ID, '100200');
  assert.ok(!(await folio.fs.list('attachments')).some((p) => /Samples/.test(p)));
});

test('marking a data file as a spec keeps it when it holds no personal data', async () => {
  const h = hold();
  const fs = new MemoryFs();
  await Folio.init(fs, { title: 'Specs', now, actor });
  const folio = new Folio(fs, { now, hold: h });
  const csv = 'field,start,length\n' + Array.from({ length: 80 }, (_, i) => `F${i},${i * 4 + 1},4`).join('\n');
  const [plain] = await folio.add({ name: 'map.csv', type: 'text/csv', data: new TextEncoder().encode(csv) }, { actor });
  assert.equal(h.got.length, 1, '80 records: held like any data file');
  const [spec] = await folio.add({ name: 'map2.csv', type: 'text/csv', data: new TextEncoder().encode(csv + '\n'), as: 'spec' }, { actor });
  assert.equal(spec.file, 'attachments/map2.csv');
  assert.equal(h.got.length, 1);
  void plain;
});

test('a held spreadsheet can be kept as a spec later, from its original', async () => {
  const h = hold();
  const fs = new MemoryFs();
  await Folio.init(fs, { title: 'Later', now, actor });
  const folio = new Folio(fs, { now, hold: h });
  const csv = 'field,start\n' + Array.from({ length: 60 }, (_, i) => `F${i},${i}`).join('\n');
  const bytes = new TextEncoder().encode(csv);
  const [held] = await folio.add({ name: 'layout.csv', type: 'text/csv', data: bytes }, { actor });
  assert.equal(held.stored.where, 'test');
  const kept = await folio.keepAsSpec(held.path, bytes, { actor });
  assert.equal(kept.file, 'attachments/layout.csv');
  const s = JSON.parse((await folio.fs.read(held.path)).text);
  assert.equal(s.stored.where, 'folio');
  assert.equal(s.kept_as_spec.by, 'chris@engine9.ai');
  const [pii] = await folio.add({ name: 'S.xlsx', type: XLSX, data: fixture('samples') }, { actor });
  await assert.rejects(folio.keepAsSpec(pii.path, fixture('samples'), { actor }), /Personal data was found/);
  await assert.rejects(folio.keepAsSpec(pii.path, bytes, { actor, force: true }), /not the file/);
  const forced = await folio.keepAsSpec(pii.path, fixture('samples'), { actor, force: true });
  assert.deepEqual(forced.summary.kept_as_spec.despite, ['EMAIL', 'PERSON_NAME', 'STREET_ADDRESS']);
});
