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

test('an email is filed in comms by date and subject, once, with provenance', async () => {
  const { folio, fs } = await make();
  const [r] = await folio.add({ name: 'Donate.eml', data: bytes(EML) }, { actor, via: 'test' });
  assert.match(r.path, /^comms\/2026-11-02-donate-button-[0-9a-f]{8}\.eml$/);
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

test('files go to attachments with Finder-style names; folder drops keep their structure', async () => {
  const { folio, fs } = await make();
  const png = new Uint8Array([137, 80, 78, 71, 0, 255]);
  const [a] = await folio.add({ name: 'shot.png', type: 'image/png', data: png }, { actor });
  const [b] = await folio.add({ name: 'shot.png', data: png }, { actor });
  assert.equal(a.path, 'attachments/shot.png');
  assert.equal(b.path, 'attachments/shot 2.png');
  assert.deepEqual([...(await fs.readBytes(a.path)).bytes], [...png]);
  const [c] = await folio.add({ name: 'logo.svg', path: 'Designs/v2/logo.svg', data: bytes('<svg/>') }, { actor });
  assert.equal(c.path, 'attachments/Designs/v2/logo.svg');
  const [d] = await folio.add({ name: '../../evil', data: bytes('x') }, { actor });
  assert.equal(d.path.split('/').length, 2); // stays one file inside attachments
  assert.ok(d.path.startsWith('attachments/') && !d.path.split('/').includes('..'));
  const [e] = await folio.add({ name: 'brief.pdf', data: bytes('%PDF') }, { actor, folder: 'notes' });
  assert.equal(e.path, 'notes/brief.pdf'); // an explicit folder is honoured for files
  const [f] = await folio.add({ name: 'x.eml', data: bytes(EML) }, { actor, folder: 'notes' });
  assert.match(f.path, /^comms\//); // but an email always goes to comms
});

test('dropped on a folio inside a folio: files, emails, links and comments go to that folio; both validate', async () => {
  const { folio, fs } = await make();
  const { folio: donate, dir } = await folio.createChild({ title: 'Donate button', type: 'bug', tags: 'payments, safari' }, { actor });
  const [file] = await donate.add({ name: 'console.log', data: bytes('TypeError') }, { actor });
  assert.equal(file.path, 'attachments/console.log');
  assert.equal(await fs.exists(`${dir}/attachments/console.log`), true);
  const [mail] = await donate.add({ name: 'm.eml', data: bytes(EML) }, { actor });
  assert.match(mail.path, /^comms\//);
  await donate.add({ url: 'https://status.example.com/incident/7' }, { actor });
  await donate.add({ text: 'Reproduced on iOS too', as: 'comment' }, { actor });
  const said = await donate.comms();
  assert.ok(said.some((m) => m.kind === 'comment' && m.text === 'Reproduced on iOS too' && m.path.endsWith('.comment.json')));
  assert.ok(said.some((m) => m.kind === 'email' && m.path === mail.path));
  assert.deepEqual(await folio.comms(), []); // the outer folio's conversation is its own
  for (const f of [folio, donate]) {
    const v = await f.validate();
    assert.equal(v.ok, true, JSON.stringify(v.problems));
  }
  assert.equal((await validateFolio(fs)).ok, true);
});

test('links and notes outside tickets; several URLs at once', async () => {
  const { folio, fs } = await make();
  const r = await folio.add({ text: 'https://example.com/a\nhttps://github.com/a/b' }, { actor });
  assert.deepEqual(r.map((x) => x.kind), ['link', 'repository']);
  assert.match(r[0].path, /^sources\/links\/2026-11-06-example-com-a-[0-9a-f]{8}\.json$/);
  assert.equal(JSON.parse((await fs.read(r[0].path)).text).url, 'https://example.com/a');
  assert.equal((await folio.add({ url: 'https://example.com/a' }, { actor }))[0].duplicate, true);
  const [n] = await folio.add({ text: 'Call Pat about the launch date\nmore' }, { actor });
  assert.equal(n.path, 'notes/2026-11-06-call-pat-about-the-launch-date.txt');
});

test('folios carry tags: normalised, edited, and gathered by the outer folio', async () => {
  const fs = new MemoryFs();
  const folio = await Folio.init(fs, { title: 'Tags', now });
  const { folio: a } = await folio.createChild({ title: 'A', tags: ['Payments', 'payments', ' safari '] }, { actor });
  assert.deepEqual((await a.manifest()).manifest.tags, ['Payments', 'safari']);
  await a.edit({ tags: 'legacy, new' }, { actor });
  assert.deepEqual((await a.manifest()).manifest.tags, ['legacy', 'new']);
  const outer = await Folio.open(fs, { nested: 'detect' });
  assert.deepEqual((await outer.overview()).tags, ['legacy', 'new']);
  await assert.rejects(a.edit({ labels: ['x'] }, { actor }), ValidationError);
});
