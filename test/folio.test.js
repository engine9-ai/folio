import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictError, Folio, MemoryFs, ValidationError, parseGithubUrl, readiness, validateFolio } from '../src/index.js';

const fixedNow = () => '2026-11-02T10:00:00.000Z';
const actor = { type: 'user', id: 'sam@example.com' };
const make = async (title = 'Test folio') => {
  const fs = new MemoryFs();
  const folio = await Folio.init(fs, { title, now: fixedNow, actor });
  return { fs, folio };
};

test('a minimal folio is just folio.json and README.md and validates', async () => {
  const { fs } = await make();
  assert.deepEqual((await fs.list()).filter((p) => !p.startsWith('history/')), ['README.md', 'folio.json']);
  assert.equal((await validateFolio(fs)).ok, true);
});

test('init refuses to overwrite an existing folio', async () => {
  const { fs } = await make();
  await assert.rejects(Folio.init(fs, { title: 'Again' }), ConflictError);
});

test('a ticket is a folio inside a folio: its own folder, folio.json and README', async () => {
  const { folio, fs } = await make();
  const r = await folio.createChild({ title: 'Password reset link loops back', type: 'bug', priority: 'high', tags: 'auth, mobile', description: 'Seen on Safari only.' }, { actor });
  assert.equal(r.dir, 'password-reset-link-loops-back');
  assert.match(r.id, /^fol-/);
  const m = JSON.parse((await fs.read(`${r.dir}/folio.json`)).text);
  assert.deepEqual([m.title, m.type, m.status, m.priority, m.tags], ['Password reset link loops back', 'bug', 'backlog', 'high', ['auth', 'mobile']]);
  assert.equal((await fs.read(`${r.dir}/README.md`)).text, '# Password reset link loops back\n\nSeen on Safari only.\n');
  // Same title again: another folder. A title that is one of Folio's own folders gets a suffix.
  assert.equal((await folio.createChild({ title: 'Password reset link loops back' })).dir, 'password-reset-link-loops-back-2');
  assert.equal((await folio.createChild({ title: 'Notes' })).dir, 'notes-folio');
  // The parent does not see the child's files, but lists the child.
  assert.ok(!(await folio.fs.list()).some((p) => p.startsWith('password-reset')));
  const kids = await folio.children();
  assert.deepEqual(kids.map((k) => k.title).sort(), ['Notes', 'Password reset link loops back', 'Password reset link loops back']);
  assert.equal((await validateFolio(fs)).ok, true);
  // A folio inside a folio inside a folio.
  const sub = await r.folio.createChild({ title: 'Check iOS' });
  assert.equal(sub.dir, 'check-ios');
  assert.equal(await fs.exists('password-reset-link-loops-back/check-ios/folio.json'), true);
});

test('every change to folio.json is recorded: who changed what, from what, to what', async () => {
  const { folio } = await make();
  await folio.edit({ status: 'active', priority: 'urgent', owner: 'pat@example.com' }, { actor, via: 'test' });
  await folio.edit({ status: 'active' }, { actor }); // no change: nothing recorded
  const h = await folio.history();
  assert.deepEqual(h.map((x) => x.type), ['created', 'updated']);
  assert.deepEqual(h[1].changes, { status: { from: 'draft', to: 'active' }, priority: { from: null, to: 'urgent' }, owner: { from: null, to: 'pat@example.com' } });
  assert.deepEqual([h[1].actor, h[1].via], [actor, 'test']);
});

test('editing: only folio fields people work with; values are checked', async () => {
  const { folio } = await make();
  await assert.rejects(folio.edit({ id: 'fol-other' }), ValidationError);
  await assert.rejects(folio.edit({ priority: 'whenever' }), ValidationError);
  await assert.rejects(folio.edit({ target_date: 'soon' }), ValidationError);
  await assert.rejects(folio.edit({ title: '' }), ValidationError);
  const m = await folio.edit({ tags: 'a, b, A', type: 'Bug', target_date: '2026-12-01' });
  assert.deepEqual([m.tags, m.type, m.target_date], [['a', 'b'], 'bug', '2026-12-01']);
  assert.equal((await folio.edit({ tags: [] })).tags, undefined);
});

test('a stale etag is a conflict, not a silent overwrite', async () => {
  const { folio } = await make();
  const { etag } = await folio.manifest();
  await folio.edit({ priority: 'high' });
  await assert.rejects(folio.edit({ priority: 'low' }, { ifMatch: etag }), ConflictError);
});

test('readiness: blockers, holds, waiting, review and in progress are told apart in plain language', async () => {
  const { folio } = await make();
  const a = await folio.createChild({ title: 'Design', status: 'active' });
  const b = await folio.createChild({ title: 'Build', status: 'planned' });
  const c = await folio.createChild({ title: 'Approve', status: 'review' });
  await b.folio.relate('blocked_by', a.id);
  let kids = Object.fromEntries((await folio.children()).map((k) => [k.title, k.readiness]));
  assert.equal(kids.Design.state, 'in_progress');
  assert.equal(kids.Build.state, 'blocked');
  assert.match(kids.Build.reasons[0], new RegExp(`Waiting for ${a.id}`));
  assert.equal(kids.Approve.state, 'waiting');
  await a.folio.setStatus('completed');
  kids = Object.fromEntries((await folio.children()).map((k) => [k.title, k.readiness]));
  assert.deepEqual([kids.Design.state, kids.Build.state, kids.Build.ready], ['done', 'ready', true]);
  assert.equal(readiness({ status: 'backlog', hold: { reason: 'budget' } }).state, 'blocked');
  assert.equal(readiness({ status: 'draft' }).state, 'draft');
  assert.equal(readiness({ status: 'planned', waiting_on: 'the client' }).reasons[0], 'Waiting on the client.');
  void c;
});

test('relationships: loops and self references are refused; unrelate removes', async () => {
  const { folio } = await make();
  const a = await folio.createChild({ title: 'A' });
  const b = await folio.createChild({ title: 'B' });
  await a.folio.relate('blocked_by', b.id);
  const others = (await folio.children()).map((k) => ({ id: k.id, relationships: k.relationships || [] }));
  await assert.rejects(b.folio.relate('blocked_by', a.id, { others }), /loop/);
  await assert.rejects(a.folio.relate('blocked_by', a.id), /loop/);
  await assert.rejects(a.folio.relate('parent', b.id), /Relationship type/);
  await a.folio.relate('related', b.id);
  assert.equal((await a.folio.manifest()).manifest.relationships.length, 2);
  await a.folio.unrelate('blocked_by', b.id);
  assert.deepEqual((await a.folio.manifest()).manifest.relationships, [{ type: 'related', target: b.id }]);
});

test('overview: the folios inside by state, what is ready, tags', async () => {
  const { folio } = await make();
  await folio.createChild({ title: 'One', tags: ['auth'] });
  await folio.createChild({ title: 'Two', status: 'active', tags: ['billing'] });
  await folio.createChild({ title: 'Three', status: 'completed' });
  const o = await folio.overview();
  assert.deepEqual(o.folios, { total: 3, ready: 1, in_progress: 1, waiting: 0, blocked: 0, draft: 0, done: 1 });
  assert.deepEqual(o.ready.map((r) => r.title), ['One']);
  assert.deepEqual(o.tags, ['auth', 'billing']);
});

test('repositories: listed as references, normalised, de-duplicated, persisted in folio.json', async () => {
  const { folio, fs } = await make();
  const r = await folio.addRepository('engine9-ai/folio-server', { actor: { id: 'sam' } });
  assert.equal(r.url, 'https://github.com/engine9-ai/folio-server');
  await folio.addRepository({ url: 'https://github.com/engine9-ai/folio/tree/main', purpose: 'Format library', role: 'secondary' });
  await folio.addRepository({ url: 'https://git.example.org/team/site.git', provider: 'git', purpose: 'Self-hosted' });
  await assert.rejects(folio.addRepository('ENGINE9-AI/Folio-Server'), /already listed/);
  const list = await folio.repositories();
  assert.equal(list.length, 3);
  assert.ok(list.every((x) => x.integration_state === 'reference_only'));
  assert.match((await fs.read('folio.json')).text, /"repository": "engine9-ai\/folio"/);
  await folio.removeRepository('engine9-ai/folio');
  assert.equal((await folio.repositories()).length, 2);
});

test('parseGithubUrl understands the references a folio might cite', () => {
  assert.deepEqual(parseGithubUrl('https://github.com/a/b/pull/12').ref, { kind: 'pull', number: 12 });
  assert.deepEqual(parseGithubUrl('https://github.com/a/b/issues/3').ref, { kind: 'issue', number: 3 });
  assert.equal(parseGithubUrl('https://github.com/a/b/commit/abc123').ref.sha, 'abc123');
  assert.equal(parseGithubUrl('https://example.com/a/b'), null);
});

test('validate flags broken references, bad relationships and secrets', async () => {
  const { folio, fs } = await make();
  const m = JSON.parse((await fs.read('folio.json')).text);
  m.relationships = [{ type: 'blocked_by', target: 'TK-099' }];
  m.links = [{ type: 'source', path: 'comms/missing.eml' }];
  await fs.write('folio.json', JSON.stringify(m));
  await fs.write('notes/oops.md', 'token: "ghp_' + 'a'.repeat(36) + '"');
  const { ok, problems } = await validateFolio(fs);
  const codes = problems.map((p) => p.code);
  assert.equal(ok, false);
  for (const c of ['broken_reference', 'manifest_relationship', 'possible_secret']) assert.ok(codes.includes(c), `expected ${c} in ${codes}`);
  void folio;
});

test('unknown optional fields survive an edit (spec 3.4)', async () => {
  const { folio, fs } = await make();
  const raw = JSON.parse((await fs.read('folio.json')).text);
  raw.x_custom = { kept: true };
  await fs.write('folio.json', JSON.stringify(raw));
  await folio.edit({ priority: 'urgent' });
  assert.deepEqual((await folio.manifest()).manifest.x_custom, { kept: true });
});

test('search finds text in this folio, not in the folios inside it', async () => {
  const { folio, fs } = await make();
  await fs.write('notes/a.md', 'The redirect only fails on mobile.');
  const child = await folio.createChild({ title: 'Safari redirect loop', description: 'redirect again' });
  assert.deepEqual((await folio.search('redirect')).map((h) => h.path), ['notes/a.md']);
  assert.deepEqual([...new Set((await child.folio.search('redirect')).map((h) => h.path))].sort(), ['README.md', 'folio.json']);
});

test('paths cannot escape the folio', async () => {
  const fs = new MemoryFs();
  for (const p of ['../x', '/etc/passwd', 'a/../../b', 'a\\b']) await assert.rejects(fs.read(p), /path|Path/i);
});
