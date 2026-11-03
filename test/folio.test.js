import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictError, Folio, MemoryFs, ValidationError, parseGithubUrl, validateFolio } from '../src/index.js';

const fixedNow = () => '2026-11-02T10:00:00Z';
const make = async (title = 'Test folio') => {
  const fs = new MemoryFs();
  const folio = await Folio.init(fs, { title, now: fixedNow });
  return { fs, folio };
};

test('a minimal folio is just folio.json and README.md and validates', async () => {
  const { fs } = await make();
  assert.deepEqual(await fs.list(), ['README.md', 'folio.json']);
  const r = await validateFolio(fs);
  assert.equal(r.ok, true, JSON.stringify(r.problems));
});

test('init refuses to overwrite an existing folio', async () => {
  const { fs } = await make();
  await assert.rejects(Folio.init(fs, { title: 'Again' }), ConflictError);
});

test('tickets get sequential ids, a creation event and a description file', async () => {
  const { folio, fs } = await make();
  const a = await folio.createTicket({ title: 'First', description: 'Details here' });
  const b = await folio.createTicket({ title: 'Second', type: 'bug', priority: 'high' });
  assert.deepEqual([a.id, b.id], ['TK-001', 'TK-002']);
  assert.ok(await fs.exists('tickets/TK-001/description.md'));
  const events = await folio.ticketEvents('TK-001');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'created');
});

test('updates bump the revision and record who changed what', async () => {
  const { folio } = await make();
  await folio.createTicket({ title: 'T' });
  const t = await folio.updateTicket('TK-001', { status: 'in_progress', owner: 'sam' }, { actor: { type: 'user', id: 'sam' } });
  assert.equal(t.revision, 2);
  const ev = (await folio.ticketEvents('TK-001')).at(-1);
  assert.equal(ev.type, 'status_changed');
  assert.deepEqual(ev.changes.status, { from: 'open', to: 'in_progress' });
  assert.equal(ev.actor.id, 'sam');
});

test('a stale expectedRevision is a conflict, not a silent overwrite', async () => {
  const { folio } = await make();
  await folio.createTicket({ title: 'T' });
  await folio.updateTicket('TK-001', { priority: 'high' }, { expectedRevision: 1 });
  await assert.rejects(folio.updateTicket('TK-001', { priority: 'low' }, { expectedRevision: 1 }), ConflictError);
  assert.equal((await folio.getTicket('TK-001')).ticket.priority, 'high');
});

test('two concurrent updates: exactly one wins and nothing is half written', async () => {
  const { folio, fs } = await make();
  await folio.createTicket({ title: 'T' });
  const results = await Promise.allSettled([
    folio.updateTicket('TK-001', { priority: 'high' }),
    folio.updateTicket('TK-001', { priority: 'low' }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const { ticket } = await folio.getTicket('TK-001');
  assert.equal(ticket.revision, 2);
  const events = (await fs.list('tickets/TK-001/events')).length;
  assert.equal(events, 2); // created + exactly one update
});

test('closing needs a resolution; editing unknown fields is refused', async () => {
  const { folio } = await make();
  await folio.createTicket({ title: 'T' });
  await assert.rejects(folio.updateTicket('TK-001', { status: 'closed' }), ValidationError);
  await assert.rejects(folio.updateTicket('TK-001', { revision: 9 }), ValidationError);
  const t = await folio.updateTicket('TK-001', { status: 'closed', resolution: 'completed', resolution_note: 'Fixed and verified.' });
  assert.equal(t.status, 'closed');
});

test('readiness: blockers, holds, waiting and in-progress are told apart in plain language', async () => {
  const { folio } = await make();
  await folio.createTicket({ title: 'Confirm behaviour' }); // 1
  await folio.createTicket({ title: 'Ship flow' }); // 2
  await folio.createTicket({ title: 'Held work' }); // 3
  await folio.createTicket({ title: 'Waiting work' }); // 4
  await folio.relate('TK-002', 'blocked_by', 'TK-001');
  await folio.updateTicket('TK-003', { hold: { reason: 'Customer asked us to pause' } });
  await folio.updateTicket('TK-004', { waiting_on: 'the customer' });
  const by = Object.fromEntries((await folio.ticketViews()).map((t) => [t.id, t]));
  assert.equal(by['TK-001'].readiness.state, 'ready');
  assert.equal(by['TK-002'].readiness.state, 'blocked');
  assert.match(by['TK-002'].readiness.reasons[0], /TK-001/);
  assert.equal(by['TK-001'].blocks[0], 'TK-002'); // inverse is visible
  assert.equal(by['TK-003'].readiness.held, true);
  assert.equal(by['TK-004'].readiness.state, 'waiting');
  assert.deepEqual((await folio.readyTickets()).map((t) => t.id), ['TK-001']);

  await folio.updateTicket('TK-001', { status: 'resolved' });
  assert.equal((await folio.ticketViews()).find((t) => t.id === 'TK-002').readiness.ready, true);
});

test('hierarchy is not a dependency; loops and self references are refused', async () => {
  const { folio } = await make();
  for (const t of ['Epic', 'Child A', 'Child B']) await folio.createTicket({ title: t });
  await folio.relate('TK-002', 'parent', 'TK-001');
  await folio.relate('TK-003', 'parent', 'TK-001');
  const views = await folio.ticketViews();
  assert.deepEqual(views.find((t) => t.id === 'TK-001').children, ['TK-002', 'TK-003']);
  assert.equal(views.find((t) => t.id === 'TK-002').readiness.ready, true);
  await assert.rejects(folio.relate('TK-001', 'parent', 'TK-002'), /loop/);
  await assert.rejects(folio.relate('TK-001', 'blocked_by', 'TK-001'), /loop/);
  await folio.relate('TK-001', 'blocked_by', 'TK-002');
  await assert.rejects(folio.relate('TK-002', 'blocked_by', 'TK-001'), /loop/);
  await assert.rejects(folio.relate('TK-002', 'parent', 'TK-003'), /already has a parent/);
});

test('hundreds of execution steps do not need to become tickets', async () => {
  const { folio, fs } = await make();
  await folio.createTicket({ title: 'Investigate sign-in' });
  for (let i = 1; i <= 200; i++) await fs.write(`tickets/TK-001/execution/${String(i).padStart(4, '0')}.json`, '{"step":' + i + '}\n');
  assert.equal((await folio.listTickets()).length, 1);
  assert.equal((await validateFolio(fs)).ok, true);
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

test('parseGithubUrl understands the references a ticket might cite', () => {
  assert.deepEqual(parseGithubUrl('https://github.com/a/b/pull/12').ref, { kind: 'pull', number: 12 });
  assert.deepEqual(parseGithubUrl('https://github.com/a/b/issues/3').ref, { kind: 'issue', number: 3 });
  assert.equal(parseGithubUrl('https://github.com/a/b/commit/abc123').ref.sha, 'abc123');
  assert.equal(parseGithubUrl('https://example.com/a/b'), null);
});

test('validate flags broken references, loops, secrets, and unattested edits', async () => {
  const { folio, fs } = await make();
  await folio.createTicket({ title: 'A' });
  await folio.createTicket({ title: 'B' });
  // Hand-edit outside the application: dangling relationship, bump revision with no event, add a secret.
  const t = JSON.parse((await fs.read('tickets/TK-001/ticket.json')).text);
  t.relationships = [{ type: 'blocked_by', target: 'TK-099' }];
  t.revision = 5;
  t.links = [{ type: 'source', path: 'sources/email/missing.eml' }];
  await fs.write('tickets/TK-001/ticket.json', JSON.stringify(t));
  await fs.write('notes/oops.md', 'token: "ghp_' + 'a'.repeat(36) + '"');
  const { ok, problems } = await validateFolio(fs);
  const codes = problems.map((p) => p.code);
  assert.equal(ok, false);
  for (const c of ['broken_reference', 'unattested_change', 'possible_secret']) assert.ok(codes.includes(c), `expected ${c} in ${codes}`);
});

test('unknown optional fields survive an edit (spec 3.4)', async () => {
  const { folio, fs } = await make();
  const t = await folio.createTicket({ title: 'A' });
  const raw = JSON.parse((await fs.read('tickets/TK-001/ticket.json')).text);
  raw.x_custom = { kept: true };
  await fs.write('tickets/TK-001/ticket.json', JSON.stringify(raw));
  await folio.updateTicket(t.id, { priority: 'urgent' });
  assert.deepEqual((await folio.getTicket(t.id)).ticket.x_custom, { kept: true });
});

test('search finds text in notes and tickets', async () => {
  const { folio, fs } = await make();
  await folio.createTicket({ title: 'Safari redirect loop' });
  await fs.write('notes/a.md', 'The redirect only fails on mobile.');
  const hits = await folio.search('redirect');
  assert.deepEqual(hits.map((h) => h.path).sort(), ['notes/a.md', 'tickets/TK-001/ticket.json']);
});

test('paths cannot escape the folio', async () => {
  const fs = new MemoryFs();
  for (const p of ['../x', '/etc/passwd', 'a/../../b', 'a\\b']) await assert.rejects(fs.read(p), /path|Path/i);
});
