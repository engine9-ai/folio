import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Folio, MemoryFs, ValidationError, classify, parseEmailHeaders, repositoryFromUrl, validateFolio } from '../src/index.js';

const now = () => '2026-11-06T15:00:00.000Z';
const actor = { type: 'user', id: 'sam@example.com' };
const make = async () => {
  const fs = new MemoryFs();
  const folio = await Folio.init(fs, { title: 'Intake', now });
  return { fs, folio };
};
const bytes = (s) => new TextEncoder().encode(s);
const EML = 'From: Pat <pat@customer.example>\r\nTo: support@agency.example\r\nSubject: =?UTF-8?B?RG9uYXRlIGJ1dHRvbiDinYw=?=\r\nDate: Mon, 02 Nov 2026 13:41:00 +0000\r\nMessage-ID: <report-1@customer.example>\r\n\r\nThe button spins.\r\n';

test('classify: repositories, links, emails, notes and files', () => {
  assert.equal(classify({ url: 'https://github.com/engine9-ai/folio/pull/12' }).kind, 'repository');
  assert.equal(classify({ text: 'git@github.com:engine9-ai/folio.git' }).repository.repository, 'engine9-ai/folio');
  assert.equal(classify({ text: 'https://gitlab.com/group/sub/proj/-/issues/3' }).repository.repository, 'group/sub/proj');
  assert.equal(classify({ url: 'https://github.com/orgs/engine9-ai' }).kind, 'link');
  assert.equal(classify({ url: 'https://example.com/docs' }).kind, 'link');
  assert.equal(classify({ text: 'https://a.example\nhttps://b.example' }).kind, 'urls');
  assert.equal(classify({ name: 'x.eml', data: bytes(EML) }).kind, 'email');
  assert.equal(classify({ name: 'Mail.msg', data: new Uint8Array([0xd0, 0xcf]) }).format, 'msg');
  assert.equal(classify({ name: 'pasted.txt', data: bytes(EML) }).kind, 'email'); // sniffed
  assert.equal(classify({ text: 'Remember to call Pat' }).kind, 'note');
  assert.equal(classify({ name: 'shot.png', type: 'image/png', data: new Uint8Array([137, 80, 78, 71]) }).kind, 'file');
  assert.equal(classify({ name: 'Link.webloc', data: bytes('<plist><dict><key>URL</key><string>https://github.com/a/b</string></dict></plist>') }).kind, 'repository');
  assert.throws(() => classify({ url: 'https://user:pw@github.com/a/b' }), ValidationError);
  assert.equal(repositoryFromUrl('https://example.com/thing.git').provider, 'git');
});

test('email headers are read, encoded words decoded', () => {
  const h = parseEmailHeaders(EML);
  assert.equal(h.subject, 'Donate button ❌');
  assert.equal(h.from, 'Pat <pat@customer.example>');
  assert.equal(h.date, '2026-11-02T13:41:00.000Z');
  assert.equal(h.message_id, '<report-1@customer.example>');
});

test('a repository URL is listed once; a second drop reports the duplicate', async () => {
  const { folio } = await make();
  const [a] = await folio.add({ url: 'https://github.com/engine9-ai/folio-server/issues/4' }, { actor });
  assert.equal(a.kind, 'repository');
  assert.equal(a.duplicate, false);
  const [b] = await folio.add({ text: 'https://github.com/engine9-ai/folio-server' }, { actor });
  assert.equal(b.duplicate, true);
  const repos = await folio.repositories();
  assert.deepEqual(repos.map((r) => r.repository), ['engine9-ai/folio-server']);
  assert.equal(repos[0].added_by, 'sam@example.com');
});

test('an email is filed under sources/email by date and subject, once, with provenance', async () => {
  const { folio, fs } = await make();
  const [r] = await folio.add({ name: 'Donate.eml', data: bytes(EML) }, { actor, via: 'test' });
  assert.match(r.path, /^sources\/email\/2026-11-02-donate-button-[0-9a-f]{8}\.eml$/);
  assert.equal((await fs.read(r.path)).text, EML); // original kept byte for byte
  const [again] = await folio.add({ text: EML }, { actor });
  assert.equal(again.duplicate, true);
  assert.equal(again.path, r.path);
  const intake = (await fs.list('history/intake'));
  assert.equal(intake.length, 1);
  const rec = JSON.parse((await fs.read(intake[0])).text);
  assert.equal(rec.kind, 'email');
  assert.equal(rec.email.subject, 'Donate button ❌');
  assert.deepEqual(rec.actor, actor);
});

test('files go to sources/uploads with Finder-style names; folder drops keep their structure', async () => {
  const { folio, fs } = await make();
  const png = new Uint8Array([137, 80, 78, 71, 0, 255]);
  const [a] = await folio.add({ name: 'shot.png', type: 'image/png', data: png }, { actor });
  const [b] = await folio.add({ name: 'shot.png', data: png }, { actor });
  assert.equal(a.path, 'sources/uploads/shot.png');
  assert.equal(b.path, 'sources/uploads/shot 2.png');
  assert.deepEqual([...(await fs.readBytes(a.path)).bytes], [...png]);
  const [c] = await folio.add({ name: 'logo.svg', path: 'Designs/v2/logo.svg', data: bytes('<svg/>') }, { actor });
  assert.equal(c.path, 'sources/uploads/Designs/v2/logo.svg');
  const [d] = await folio.add({ name: '../../evil', data: bytes('x') }, { actor });
  assert.equal(d.path.split('/').length, 3); // stays one file inside sources/uploads
  assert.ok(d.path.startsWith('sources/uploads/') && !d.path.split('/').includes('..'));
  const [e] = await folio.add({ name: 'brief.pdf', data: bytes('%PDF') }, { actor, folder: 'notes' });
  assert.equal(e.path, 'notes/brief.pdf'); // an explicit folder is honoured for files
  const [f] = await folio.add({ name: 'x.eml', data: bytes(EML) }, { actor, folder: 'notes' });
  assert.match(f.path, /^sources\/email\//); // but an email always goes to sources/email
});

test('dropped on a ticket: attachments, linked sources and links, text becomes a comment; the folio still validates', async () => {
  const { folio, fs } = await make();
  await folio.createTicket({ title: 'Donate button', tags: 'payments, safari' }, { actor });
  const [file] = await folio.add({ name: 'console.log', data: bytes('TypeError') }, { actor, ticket: 'TK-001' });
  assert.equal(file.path, 'tickets/TK-001/attachments/console.log');
  const [mail] = await folio.add({ name: 'm.eml', data: bytes(EML) }, { actor, ticket: 'TK-001' });
  assert.match(mail.path, /^sources\/email\//);
  await folio.add({ url: 'https://status.example.com/incident/7' }, { actor, ticket: 'TK-001' });
  await folio.add({ text: 'Reproduced on iOS too' }, { actor, ticket: 'TK-001' });
  const [viaFolder] = await folio.add({ name: 'b.txt', data: bytes('b') }, { actor, folder: 'tickets/TK-001/events' });
  assert.equal(viaFolder.path, 'tickets/TK-001/attachments/b.txt');
  const { ticket } = await folio.getTicket('TK-001');
  assert.deepEqual(ticket.links.map((l) => l.type), ['attachment', 'source', 'url', 'attachment']);
  const events = await folio.ticketEvents('TK-001');
  assert.ok(events.some((e) => e.type === 'comment' && e.comment === 'Reproduced on iOS too'));
  assert.ok(events.some((e) => e.type === 'linked'));
  assert.equal((await fs.list('sources/links')).length, 0); // the ticket holds the link
  const v = await validateFolio(fs);
  assert.equal(v.ok, true, JSON.stringify(v.problems));
  await assert.rejects(folio.add({ text: 'x' }, { ticket: 'TK-999' }));
});

test('links and notes outside tickets; several URLs at once', async () => {
  const { folio, fs } = await make();
  const r = await folio.add({ text: 'https://example.com/a\nhttps://github.com/a/b' }, { actor });
  assert.deepEqual(r.map((x) => x.kind), ['link', 'repository']);
  assert.match(r[0].path, /^sources\/links\/2026-11-06-example-com-a-[0-9a-f]{8}\.json$/);
  assert.equal(JSON.parse((await fs.read(r[0].path)).text).url, 'https://example.com/a');
  assert.equal((await folio.add({ url: 'https://example.com/a' }, { actor }))[0].duplicate, true);
  const [n] = await folio.add({ text: 'Call Pat about the launch date\nmore' }, { actor });
  assert.equal(n.path, 'notes/2026-11-06-call-pat-about-the-launch-date.md');
});

test('tickets carry tags; the older labels field still reads and is replaced on edit', async () => {
  const fs = new MemoryFs();
  const folio = await Folio.init(fs, { title: 'Tags', now });
  await folio.createTicket({ title: 'A', tags: ['Payments', 'payments', ' safari '] }, { actor });
  assert.deepEqual((await folio.getTicket('TK-001')).ticket.tags, ['Payments', 'safari']);
  const { ticket, etag } = await folio.getTicket('TK-001');
  await fs.write('tickets/TK-001/ticket.json', JSON.stringify({ ...ticket, tags: undefined, labels: ['legacy'] }), { ifMatch: etag });
  assert.deepEqual((await folio.ticketViews())[0].tags, ['legacy']);
  const t = await folio.updateTicket('TK-001', { tags: 'legacy, new' }, { actor });
  assert.deepEqual(t.tags, ['legacy', 'new']);
  assert.equal(t.labels, undefined);
  assert.deepEqual((await folio.overview()).tags, ['legacy', 'new']);
  await assert.rejects(folio.updateTicket('TK-001', { labels: ['x'] }, { actor }), ValidationError);
});
