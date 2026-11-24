import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Folio, MemoryFs, binaryString, detachedFiles, emailFileParts, parseEmail } from '../src/index.js';

const now = () => '2026-11-24T15:00:00.000Z';
const actor = { type: 'user', id: 'sam@agency.example' };
const agent = { type: 'agent', id: 'claude', on_behalf_of: 'sam@agency.example' };
const enc = (s) => new TextEncoder().encode(s);
const b64 = (bytes) => btoa(binaryString(bytes)).replace(/.{76}/g, '$&\r\n');
const make = async () => {
  const fs = new MemoryFs();
  const folio = await Folio.init(fs, { title: 'Email records', now });
  return { fs, folio };
};

const pdf = Uint8Array.from({ length: 120000 }, (_, i) => (i * 7) % 256);
const logo = Uint8Array.from({ length: 900 }, (_, i) => i % 256);
const shot = Uint8Array.from({ length: 60000 }, (_, i) => (i * 3) % 256);

const WITH_FILES = [
  'From: Dana Example <dana@client.example>',
  'To: folio+fol-1@engine9.ai',
  'Subject: Re: Renewal report',
  'Date: Tue, 24 Nov 2026 09:15:00 +0000',
  'Message-ID: <r3@client.example>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="mix"',
  '',
  '--mix',
  'Content-Type: multipart/related; boundary="rel"',
  '',
  '--rel',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>The report is attached, and the error is in the screenshot.</p><img src="cid:logo1"><img src="cid:shot1">',
  '<p>On Mon, 23 Nov 2026 Sam wrote:</p><blockquote>Can you send the renewal report?</blockquote>',
  '--rel',
  'Content-Type: image/png; name="logo.png"',
  'Content-ID: <logo1>',
  'Content-Disposition: inline; filename="logo.png"',
  'Content-Transfer-Encoding: base64',
  '',
  b64(logo),
  '--rel',
  'Content-Type: image/png; name="screenshot.png"',
  'Content-ID: <shot1>',
  'Content-Disposition: inline; filename="screenshot.png"',
  'Content-Transfer-Encoding: base64',
  '',
  b64(shot),
  '--rel--',
  '',
  '--mix',
  'Content-Type: application/pdf; name="renewal report.pdf"',
  'Content-Disposition: attachment; filename="renewal report.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  b64(pdf),
  '--mix--',
  '',
].join('\r\n');

test('an email is a small record in comms, the email itself in sources/email, each attachment a file', async () => {
  const { fs, folio } = await make();
  const [r] = await folio.add({ name: 'renewal.eml', data: enc(WITH_FILES) }, { actor, via: 'test' });
  assert.match(r.path, /^comms\/2026-11-24-091500-renewal-report-[0-9a-f]{8}\.email\.json$/);
  assert.match(r.original, /^sources\/email\/2026-11-24-renewal-report-[0-9a-f]{8}\.eml$/);
  const stem = r.original.slice('sources/email/'.length, -'.eml'.length);
  assert.deepEqual(r.attachments.sort(), [`attachments/${stem}/renewal report.pdf`, `attachments/${stem}/screenshot.png`]);
  // Each attachment is kept once, byte for byte; the small signature logo stays inside the email.
  assert.deepEqual((await fs.readBytes(`attachments/${stem}/renewal report.pdf`)).bytes, pdf);
  assert.deepEqual((await fs.readBytes(`attachments/${stem}/screenshot.png`)).bytes, shot);
  const kept = (await fs.read(r.original)).text;
  assert.ok(kept.length < WITH_FILES.length / 2, 'the email no longer carries its attachments');
  assert.match(kept, /Content-Type: message\/external-body; access-type=local-file; name="attachments\/[^"]+\/renewal report\.pdf"/);
  assert.match(kept, /Content-ID: <logo1>\r\nContent-Disposition: inline; filename="logo.png"/);
  assert.deepEqual(detachedFiles(kept).map((f) => [f.name, f.type, f.size]), [['screenshot.png', 'image/png', shot.length], ['renewal report.pdf', 'application/pdf', pdf.length]]);
  assert.deepEqual(emailFileParts(kept).map((p) => p.name), ['logo.png']);
  // Everything outside the attachments is unchanged.
  assert.equal(kept.slice(0, kept.indexOf('--rel\r\nContent-Type: image/png')), WITH_FILES.slice(0, WITH_FILES.indexOf('--rel\r\nContent-Type: image/png')));
  assert.match(parseEmail(kept).text, /The report is attached/);

  const rec = JSON.parse((await fs.read(r.path)).text);
  assert.equal(rec.author.id, 'dana@client.example');
  assert.equal(rec.headers.subject, 'Re: Renewal report');
  assert.match(rec.text, /^The report is attached, and the error is in the screenshot\.$/);
  assert.equal(rec.trimmed, true);
  assert.equal(rec.original.copy, 'attachments_as_files');
  assert.equal(rec.original.received_size, WITH_FILES.length);
  assert.deepEqual(rec.attachments.map((a) => [a.name, a.size, Boolean(a.inline)]), [['screenshot.png', shot.length, true], ['renewal report.pdf', pdf.length, false]]);

  const [item] = await folio.comms();
  assert.equal(item.kind, 'email');
  assert.equal(item.thread, 'client');
  assert.equal(item.original, r.original);
  assert.equal(item.attachments.length, 2);

  const full = await folio.email(r.path);
  assert.match(full.text, /Can you send the renewal report\?/, 'the whole email, quoted history included');
  assert.equal((await folio.email(r.original)).path, r.path, 'found from the email itself too');
});

const THREAD = [
  'From: Dana Example <dana@client.example>',
  'To: sam@agency.example',
  'Subject: Re: Re: Gift import',
  'Date: Wed, 18 Nov 2026 16:02:00 +0000',
  'Message-ID: <t3@client.example>',
  '',
  'Thursday works. Please use the new file.',
  '',
  'Dana',
  '-- ',
  'Dana Example | Client Org',
  '',
  'On Tue, 17 Nov 2026 at 10:00, Sam <sam@agency.example> wrote:',
  ...Array.from({ length: 400 }, (_, i) => `> earlier line ${i} of the thread, quoted again in every reply`),
  '',
].join('\r\n');

test('a long thread: the record carries what was written last, the email keeps the history', async () => {
  const { fs, folio } = await make();
  const [r] = await folio.add({ name: 'thread.eml', data: enc(THREAD) }, { actor });
  const rec = JSON.parse((await fs.read(r.path)).text);
  assert.equal(rec.text, 'Thursday works. Please use the new file.\n\nDana');
  assert.ok(rec.full_chars > 20000);
  assert.ok((await fs.read(r.path)).text.length < 2000, 'the conversation stays small');
  const [listed] = await folio.emails();
  assert.equal(listed.text, rec.text);
  assert.equal(listed.truncated, true, 'says there is more');
  const [whole] = await folio.emails({ full: true, maxChars: 100000 });
  assert.match(whole.text, /earlier line 399/);
});

test('an agent files an email from its fields, with its own summary; a model never replaces it', async () => {
  const { fs, folio } = await make();
  const [r] = await folio.addEmail(
    {
      from: 'Dana Example <dana@client.example>',
      to: ['sam@agency.example'],
      subject: 'Re: Gift import',
      date: '2026-11-18T16:02:00Z',
      message_id: 't3@client.example',
      text: 'Thursday works. Please use the new file.\n\nOn Tue, Sam wrote:\n> Which day?',
      attachments: [{ name: 'notes.txt', type: 'text/plain', data: btoa('import notes') }],
      summary: 'Dana confirmed Thursday for the gift import and asked us to use the new file (the thread began 10 Nov).',
    },
    { actor: agent, via: 'test/mcp' }
  );
  const rec = JSON.parse((await fs.read(r.path)).text);
  assert.equal(rec.headers.message_id, '<t3@client.example>');
  assert.equal(rec.text, 'Thursday works. Please use the new file.');
  assert.equal(rec.summary.by.type, 'agent');
  assert.equal(rec.summary.by.on_behalf_of, 'sam@agency.example');
  assert.equal((await fs.read(r.attachments[0])).text, 'import notes');

  assert.equal(await folio.setEmailSummary(r.path, 'A model summary', { by: { type: 'model', id: 'm' }, onlyIfMissing: true }), null);
  const [item] = await folio.comms();
  assert.match(item.summary, /^Dana confirmed Thursday/);

  await folio.setEmailSummary(r.path, 'Corrected by Sam', { actor });
  assert.equal(JSON.parse((await fs.read(r.path)).text).summary.text, 'Corrected by Sam');
  await folio.setEmailSummary(r.path, '', { actor });
  assert.equal(JSON.parse((await fs.read(r.path)).text).summary, undefined);
});

test('the same email again is not filed twice, but a summary brought with it is kept', async () => {
  const { fs, folio } = await make();
  const [a] = await folio.add({ name: 't.eml', data: enc(THREAD) }, { actor });
  const [b] = await folio.add({ name: 't.eml', data: enc(THREAD), summary: 'Thursday confirmed.' }, { actor: agent });
  assert.equal(b.duplicate, true);
  assert.equal(b.path, a.path);
  assert.match(b.summary, /added the summary/);
  assert.equal(JSON.parse((await fs.read(a.path)).text).summary.text, 'Thursday confirmed.');
  assert.equal((await fs.list('sources/email')).length, 1);
});

test('an email goes to the Trash with the email itself and its attachments, and comes back with them', async () => {
  const { fs, folio } = await make();
  const [r] = await folio.add({ name: 'renewal.eml', data: enc(WITH_FILES) }, { actor });
  const e = await folio.moveToTrash(r.path, { actor });
  assert.equal(e.files.length, 4);
  assert.deepEqual(await folio.comms(), []);
  assert.deepEqual(await fs.list('sources/email'), []);
  assert.deepEqual(await fs.list('attachments'), []);
  await folio.restoreFromTrash(e.id, { actor });
  assert.equal((await folio.comms()).length, 1);
  assert.equal((await fs.list('attachments')).length, 2);
});

test('a mail-client link finds an email filed as a record', async () => {
  const { folio } = await make();
  const [r] = await folio.add({ name: 't.eml', data: enc(THREAD) }, { actor });
  const [s] = await folio.add({ text: 'message:%3Ct3@client.example%3E' }, { actor });
  assert.equal(s.path, r.path);
});

test('emails filed before 1.9 (an .eml in comms/) are still read', async () => {
  const { fs, folio } = await make();
  await fs.write('comms/2026-11-02-old-1a2b3c4d.eml', THREAD, { contentType: 'message/rfc822' });
  const [item] = await folio.comms();
  assert.equal(item.kind, 'email');
  assert.equal(item.subject, 'Re: Re: Gift import');
  const [listed] = await folio.emails({ maxChars: 100000 });
  assert.match(listed.text, /earlier line 399/);
  await assert.rejects(folio.setEmailSummary('comms/2026-11-02-old-1a2b3c4d.eml', 'x'), /no record to summarise/);
});

test('8-bit bodies in other charsets are kept byte for byte when attachments leave the email', async () => {
  const { fs, folio } = await make();
  const head = enc('From: René <rene@client.example>\r\nSubject: Café\r\nDate: Tue, 24 Nov 2026 10:00:00 +0000\r\nMessage-ID: <l1@client.example>\r\nContent-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: 8bit\r\n\r\nCaf');
  const latin = new Uint8Array([0xe9, 0x20, 0x6f, 0x6b]); // "é ok" in ISO-8859-1
  const tail = enc(`\r\n--b\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="a.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(pdf)}\r\n--b--\r\n`);
  const raw = new Uint8Array([...head, ...latin, ...tail]);
  const [r] = await folio.add({ name: 'l.eml', data: raw }, { actor });
  const kept = (await fs.readBytes(r.original)).bytes;
  const n = head.length + latin.length;
  assert.deepEqual(kept.subarray(0, n), raw.subarray(0, n));
});
