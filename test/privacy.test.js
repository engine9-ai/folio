import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Folio, MemoryFs, classify, dataFormat, emailAttachments, parseDelimited, scrubText, summarizeData, validateFolio } from '../src/index.js';

const now = () => '2026-11-07T15:00:00.000Z';
const actor = { type: 'user', id: 'sam@agency.example' };
const enc = (s) => new TextEncoder().encode(s);

/** A stand-in for folio-server's R2 hold bucket. */
class FakeHold {
  constructor() {
    this.items = new Map();
  }
  async put(bytes, meta) {
    const key = `holds/fol-test/${meta.sha256.slice(0, 12)}-${meta.name}`;
    this.items.set(key, { bytes, meta });
    return { store: 'test', key, expires_at: '2026-12-07T15:00:00.000Z' };
  }
}

const make = async (hold = new FakeHold()) => {
  const fs = new MemoryFs();
  await Folio.init(fs, { title: 'Privacy', now });
  const folio = await Folio.open(fs, { now, hold });
  return { fs, folio, hold };
};

const FIRST = ['Maria', 'James', 'Aisha', 'Wei', 'Olu', 'Sara', 'Tom', 'Ana'];
const LAST = ['Lopez', 'Smith', 'Khan', 'Chen', 'Ade', 'Berg', 'Ng', 'Ruiz'];
const donorsCsv = (n) => {
  const rows = ['donor_id,first_name,last_name,email,phone,amount,gift_date,notes'];
  for (let i = 0; i < n; i++) rows.push(`${1000 + i},${FIRST[i % 8]},${LAST[(i * 3) % 8]},${FIRST[i % 8].toLowerCase()}${i}@example.org,415-867-${String(1000 + i).slice(-4)},${(i * 1.5).toFixed(2)},2026-10-${String(1 + (i % 28)).padStart(2, '0')},"Called, said ""thanks"""`);
  return rows.join('\r\n') + '\r\n';
};

test('a donor export is summarised in sources/data and held, not stored', async () => {
  const { fs, folio, hold } = await make();
  const csv = enc(donorsCsv(300));
  const [r] = await folio.add({ name: 'donors-oct.csv', type: 'text/csv', data: csv }, { actor });
  assert.equal(r.kind, 'data');
  assert.match(r.path, /^sources\/data\/2026-11-07-donors-oct-[0-9a-f]{8}\.json$/);
  assert.equal(r.records, 300);
  assert.deepEqual(r.pii, ['EMAIL', 'PERSON_NAME', 'PHONE_US']);
  assert.match(r.summary, /300 records, 8 fields; personal data .* masked .*held in temporary storage until 2026-12-07/);

  const files = await fs.list();
  assert.ok(!files.some((f) => f.endsWith('.csv')), 'the CSV itself is not in the folio');
  assert.equal(hold.items.size, 1);
  const [held] = hold.items.values();
  assert.deepEqual(held.bytes, csv);

  const s = JSON.parse((await fs.read(r.path)).text);
  assert.equal(s.kind, 'folio.data_summary');
  assert.equal(s.stored.where, 'held');
  assert.equal(s.stored.key, [...hold.items.keys()][0]);
  assert.equal(s.size, csv.length);
  assert.equal(s.submitted_by, 'sam@agency.example');
  const field = (n) => s.fields.find((f) => f.name === n);
  assert.equal(field('donor_id').type, 'integer');
  assert.equal(field('donor_id').identifier, true);
  assert.deepEqual(field('donor_id').examples, ['1000', '1001', '1002'], 'ids are kept');
  assert.deepEqual(field('email').pii.types, ['EMAIL']);
  assert.equal(field('amount').type, 'number');
  assert.equal(field('gift_date').type, 'date');
  assert.equal(s.sample.length, 5);
  const text = JSON.stringify(s);
  assert.doesNotMatch(text, /maria0@example\.org|Lopez|867-1000/, 'no personal data in the summary');
  assert.equal(s.sample[0].email, 'm***@***.org');
  assert.equal(s.sample[0].notes, 'Called, said "thanks"');

  // Provenance, and a second drop of the same bytes is recognised.
  const intake = (await fs.list('history/intake')).map(async (p) => JSON.parse((await fs.read(p)).text));
  assert.equal((await Promise.all(intake))[0].kind, 'data');
  const [again] = await folio.add({ name: 'copy.csv', data: csv }, { actor });
  assert.equal(again.duplicate, true);
  assert.equal(hold.items.size, 1);
});

test('without temporary storage only the summary is kept', async () => {
  const { fs, folio } = await make(null);
  const [r] = await folio.add({ name: 'donors.csv', data: enc(donorsCsv(60)) }, { actor });
  assert.match(r.summary, /the file itself was not kept/);
  assert.equal(JSON.parse((await fs.read(r.path)).text).stored.where, 'not_kept');
});

test('a small query result with no personal data stays an ordinary file', async () => {
  const { fs, folio, hold } = await make();
  const [r] = await folio.add({ name: 'counts.csv', data: enc('campaign_id,gifts,total\nC-1,12,340.50\nC-2,3,75\n') }, { actor, ticket: undefined });
  assert.equal(r.kind, 'file');
  assert.equal(r.path, 'attachments/counts.csv');
  assert.equal(hold.items.size, 0);
  const rec = JSON.parse((await fs.read((await fs.list('history/intake'))[0])).text);
  assert.deepEqual(rec.data, { format: 'csv', records: 2, fields: 3 });
});

test('a data file dropped on a ticket is linked from it', async () => {
  const { folio } = await make();
  await folio.createTicket({ title: 'Gift totals wrong' }, { actor });
  const [r] = await folio.add({ name: 'gifts.jsonl', data: enc(Array.from({ length: 80 }, (_, i) => JSON.stringify({ id: i, member: { email: `m${i}@example.net`, name: 'x' }, amount: i })).join('\n')) }, { actor, ticket: 'TK-001' });
  assert.equal(r.kind, 'data');
  assert.equal(r.records, 80);
  assert.ok(r.pii.includes('EMAIL'));
  const { ticket } = await folio.getTicket('TK-001');
  assert.ok(ticket.links.some((l) => l.path === r.path && l.label === 'Data: gifts.jsonl'));
});

test('logs: lines, time range, levels, redacted samples', async () => {
  const lines = Array.from({ length: 50 }, (_, i) => `2026-11-07T10:${String(i).padStart(2, '0')}:00Z ${i % 10 ? 'INFO' : 'ERROR'} checkout for ana${i}@example.org from 203.0.113.${i} card 4539 1488 0343 6467`);
  const s = await summarizeData(enc(lines.join('\n') + '\n'), { name: 'app.log' });
  assert.equal(s.format, 'log');
  assert.equal(s.logs.lines, 50);
  assert.equal(s.logs.first_at, '2026-11-07T10:00:00Z');
  assert.equal(s.logs.last_at, '2026-11-07T10:49:00Z');
  assert.deepEqual(s.logs.levels, { ERROR: 5, INFO: 45 });
  assert.equal(s.sample.errors.length, 5);
  const text = JSON.stringify(s.sample);
  assert.doesNotMatch(text, /ana0@example\.org|203\.0\.113|4539 1488/);
  assert.ok(s.pii.types.includes('PAYMENT_CARD'));
  // A .txt that is plainly a log is recognised too.
  assert.equal(dataFormat({ name: 'server.txt', type: 'text/plain', bytes: enc(lines.join('\n')) }).format, 'log');
});

test('large files: counted over the bytes, sampled from the head', async () => {
  const csv = enc(donorsCsv(20000));
  assert.ok(csv.length > 1024 * 1024);
  const s = await summarizeData(csv, { name: 'big.csv' });
  assert.equal(s.records, 20000);
  assert.ok(s.sampled_records < 20000);
  assert.match(s.notes.join(' '), /first 1024 KB/);
  const big = enc('[' + Array.from({ length: 220000 }, (_, i) => JSON.stringify({ id: i, email: `p${i}@example.com` })).join(',') + ']');
  assert.ok(big.length > 8 * 1024 * 1024);
  const j = await summarizeData(big, { name: 'export.json' });
  assert.equal(j.records, 220000);
  assert.deepEqual(j.pii.types, ['EMAIL']);
});

test('spreadsheets and compressed exports are held, recorded by name only', async () => {
  const { folio, hold } = await make();
  const [r] = await folio.add({ name: 'members.xlsx', data: new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]) }, { actor });
  assert.equal(r.kind, 'data');
  assert.match(r.summary, /spreadsheet; not read, so treated as personal data/);
  assert.equal(hold.items.size, 1);
  assert.equal(classify({ name: 'dump.sql.gz', data: new Uint8Array([31, 139]) }).kind, 'data');
});

test('JSON that is not a list of records is an ordinary file', () => {
  assert.equal(classify({ name: 'settings.json', data: enc('{"theme":"dark","limits":{"a":1}}') }).kind, 'file');
  assert.equal(classify({ name: 'rows.json', data: enc('{"results":[{"a":1},{"a":2}]}') }).kind, 'data');
});

test('notes, comments and ticket descriptions lose card numbers and credentials', async () => {
  const { fs, folio } = await make();
  const [n] = await folio.add({ text: 'Admin login: password: Hunter2-prod\nDonor paid with 4539 1488 0343 6467, test card 4242 4242 4242 4242' }, { actor });
  const saved = (await fs.read(n.path)).text;
  assert.doesNotMatch(saved, /Hunter2-prod|4539 1488 0343 6467/);
  assert.match(saved, /password manager/);
  assert.match(saved, /4242 4242 4242 4242/, 'test cards are fine');
  assert.match(n.summary, /removed 1 credential and 1 card number|removed 1 card number and 1 credential/);

  await folio.createTicket({ title: 'Refund', description: 'SSN on file 219-09-9999 for the donor' }, { actor });
  assert.doesNotMatch((await fs.read('tickets/TK-001/description.md')).text, /219-09-9999/);
  await folio.comment('TK-001', 'Token: ghp_abcdefghijklmnopqrstuvwxyz0123456789', { actor });
  const events = await folio.ticketEvents('TK-001');
  assert.doesNotMatch(JSON.stringify(events), /ghp_abcdefghijklmnopqrstuvwxyz0123456789/);

  // Client contact details are expected and kept.
  assert.equal(scrubText('Pat Jones, pat@client.example, 415-867-5309').total, 0);
});

test('text files are scrubbed; images keep their bytes', async () => {
  const { fs, folio } = await make();
  const [t] = await folio.add({ name: 'setup.md', data: enc('Stripe key sk_live_abcdefghijklmnop1234\nDB: postgres://app:s3cretpass@db.example.com/prod\n') }, { actor });
  const saved = (await fs.read(t.path)).text;
  assert.doesNotMatch(saved, /sk_live_abcdefghijklmnop1234|s3cretpass/);
  assert.match(saved, /db\.example\.com/);
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 52, 53, 51, 57]);
  const [img] = await folio.add({ name: 'shot.png', type: 'image/png', data: png }, { actor });
  assert.deepEqual((await fs.readBytes(img.path)).bytes, png);
});

test('key files are refused and code folders skipped', async () => {
  const { fs, folio } = await make();
  for (const name of ['.env', 'id_rsa', 'server.pem', 'vault.kdbx']) {
    const [r] = await folio.add({ name, data: enc('x') }, { actor });
    assert.equal(r.kind, 'refused', name);
  }
  assert.equal(classify({ name: '.env.example', data: enc('API_KEY=') }).kind, 'file');
  const [s] = await folio.add({ name: 'HEAD', path: 'site/.git/HEAD', data: enc('ref: refs/heads/main') }, { actor });
  assert.equal(s.kind, 'skipped');
  assert.ok(!(await fs.list()).some((p) => p.includes('.git') || p.includes('.env')));
});

const MIXED = [
  'From: Pat <pat@client.example>',
  'To: support@agency.example',
  'Subject: Donor list and a card',
  'Date: Tue, 03 Nov 2026 09:00:00 +0000',
  'Message-ID: <list-1@client.example>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="b1"',
  '',
  '--b1',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Here is the export. The donor who called paid with 4539 1488 0343 6467.',
  '--b1',
  'Content-Type: text/csv; name="donors.csv"',
  'Content-Disposition: attachment; filename="donors.csv"',
  'Content-Transfer-Encoding: base64',
  '',
  btoa(donorsCsv(40)).replace(/.{76}/g, '$&\n'),
  '--b1',
  'Content-Type: image/png; name="screen.png"',
  'Content-Disposition: attachment; filename="screen.png"',
  'Content-Transfer-Encoding: base64',
  '',
  btoa(String.fromCharCode(137, 80, 78, 71)),
  '--b1--',
  '',
].join('\r\n');

test('an email with a card number and a data attachment is kept as a text copy', async () => {
  const { fs, folio, hold } = await make();
  await folio.createTicket({ title: 'Donor list' }, { actor });
  assert.equal(emailAttachments(MIXED).length, 2);
  const results = await folio.add({ name: 'list.eml', data: enc(MIXED) }, { actor, ticket: 'TK-001' });
  const [email, data] = results;
  assert.equal(email.kind, 'email');
  assert.equal(data.kind, 'data');
  assert.equal(data.records, 40);
  assert.match(email.summary, /text copy without 1 card number and data attachments \(summarised\); the original is held/);
  const copy = (await fs.read(email.path)).text;
  assert.match(copy, /^From: Pat <pat@client\.example>\r\n/);
  assert.match(copy, /X-Folio-Copy: text copy; removed 1 card number; original held until 2026-12-07/);
  assert.match(copy, /Content-Type: text\/plain; charset=utf-8/);
  assert.doesNotMatch(copy, /4539 1488 0343 6467|multipart|base64/);
  assert.match(copy, /donors\.csv: sources\/data\//);
  assert.match(copy, /screen\.png: attachments\//);
  assert.equal(hold.items.size, 2, 'the original email and the CSV');
  const { ticket } = await folio.getTicket('TK-001');
  assert.ok(ticket.links.some((l) => l.path === email.path));
  assert.ok(ticket.links.some((l) => l.path === data.path));
  const emails = await folio.emails();
  assert.match(emails[0].text, /paid with \*\*\*\* \*\*\*\* \*\*\*\* 6467/);
});

test('an ordinary email is stored exactly as received', async () => {
  const { fs, folio, hold } = await make();
  const raw = 'From: Pat <pat@client.example>\r\nSubject: Button\r\nDate: Mon, 02 Nov 2026 13:41:00 +0000\r\nMessage-ID: <b@x>\r\n\r\nCall me at 415-867-5309.\r\n';
  const [r] = await folio.add({ name: 'b.eml', data: enc(raw) }, { actor });
  assert.equal((await fs.read(r.path)).text, raw);
  assert.equal(hold.items.size, 0);
});

test('release, pull request and issue links are recorded on the repository', async () => {
  const { folio } = await make();
  const [a] = await folio.add({ url: 'https://github.com/engine9-ai/folio/releases/tag/v0.3.0' }, { actor });
  assert.match(a.summary, /Listed repository engine9-ai\/folio with release v0\.3\.0/);
  const [b] = await folio.add({ url: 'https://github.com/engine9-ai/folio/pull/12' }, { actor });
  assert.match(b.summary, /Recorded pull request #12 on engine9-ai\/folio/);
  const [c] = await folio.add({ url: 'https://github.com/engine9-ai/folio/pull/12' }, { actor });
  assert.match(c.summary, /already recorded/);
  const [repo] = await folio.repositories();
  assert.deepEqual(repo.references.map((r) => r.kind), ['release', 'pull']);
  assert.equal(repo.references[0].url, 'https://github.com/engine9-ai/folio/releases/tag/v0.3.0');
  assert.equal((await folio.validate()).ok, true);
});

test('validate flags prohibited content, datasets and codebases', async () => {
  const fs = new MemoryFs();
  await Folio.init(fs, { title: 'Bad', now });
  await fs.write('notes/cards.md', 'Card 4539 1488 0343 6467\n');
  await fs.write('notes/login.md', 'password: Hunter2-prod\n');
  await fs.write('notes/ok.md', 'password: see 1Password "Folio admin"\n');
  await fs.write('sources/uploads/all-members.csv', donorsCsv(2000));
  for (let i = 0; i < 12; i++) await fs.write(`sources/uploads/app/src/file${i}.ts`, 'export const x = 1;\n');
  await fs.write('samples/query.sql', 'select 1;\n');
  const { ok, problems } = await validateFolio(fs);
  assert.equal(ok, false);
  const codes = (path) => problems.filter((p) => p.path === path).map((p) => p.code);
  assert.deepEqual(codes('notes/cards.md'), ['prohibited_content']);
  assert.deepEqual(codes('notes/login.md'), ['possible_secret']);
  assert.deepEqual(codes('notes/ok.md'), []);
  assert.ok(codes('sources/uploads/all-members.csv').includes('dataset_in_folio'));
  assert.ok(problems.some((p) => p.code === 'source_code'));
});

test('CSV parsing: quotes, doubled quotes, newlines in fields', () => {
  assert.deepEqual(parseDelimited('a,b\n"x, y","he said ""hi""\nthen left"\n'), [['a', 'b'], ['x, y', 'he said "hi"\nthen left']]);
});
