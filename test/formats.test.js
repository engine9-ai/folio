import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FOLIO_TYPES, Folio, LEGACY_TYPES, MemoryFs, ValidationError, classify, detectTextFormat, intakeChoices, nestedFolioDirs, titleOfText } from '../src/index.js';

const now = () => '2026-11-09T15:00:00.000Z';
const actor = { type: 'user', id: 'sam@example.com' };
const make = async () => {
  const fs = new MemoryFs();
  return { fs, folio: await Folio.init(fs, { title: 'Formats', now }) };
};

test('detectTextFormat: Markdown, HTML and plain text', () => {
  const md = '# Kickoff notes\n\n- Budget agreed\n- Launch in **March**\n\nSee [the brief](https://example.com/brief).';
  assert.equal(detectTextFormat(md).format, 'markdown');
  assert.equal(detectTextFormat('```js\nconst a = 1;\n```\nThat is the fix.').format, 'markdown');
  assert.equal(detectTextFormat('| a | b |\n|---|---|\n| 1 | 2 |').format, 'markdown');
  assert.equal(detectTextFormat('<h1>Brief</h1><p>Launch in <b>March</b>.</p>').format, 'html');
  assert.equal(detectTextFormat('<!DOCTYPE html><html><head><title>T</title></head><body>x</body></html>').format, 'html');
  assert.equal(detectTextFormat('Hi Pat,\n\nThe button spins on Safari. 2 * 3 = 6, and a < b.\n\nThanks').format, 'text');
  assert.equal(detectTextFormat('Just one *word* here').format, 'text'); // one weak sign is not enough
  // A Markdown document with a little inline HTML is still Markdown.
  assert.equal(detectTextFormat('## Steps\n\n1. Open the page<br>\n2. Click **Donate**').format, 'markdown');
  assert.equal(titleOfText(md), 'Kickoff notes');
  assert.equal(titleOfText('<html><head><title>The Brief</title></head></html>', 'html'), 'The Brief');
});

test('pasted text is saved as .md, .html or .txt by what it looks like', async () => {
  const { folio, fs } = await make();
  const [md] = await folio.add({ text: '# Kickoff notes\n\n- Budget agreed\n- Launch in March' }, { actor });
  assert.equal(md.path, 'notes/2026-11-09-kickoff-notes.md');
  assert.equal(md.format, 'markdown');
  const [html] = await folio.add({ text: '<h1>Brand guide</h1><p>Use the <em>teal</em>.</p>' }, { actor });
  assert.equal(html.path, 'notes/2026-11-09-brand-guide.html');
  const [txt] = await folio.add({ text: 'Call Pat on Tuesday' }, { actor });
  assert.equal(txt.path, 'notes/2026-11-09-call-pat-on-tuesday.txt');
  assert.match(txt.summary, /text note/);
  // A chosen name and a chosen type.
  const [named] = await folio.add({ text: 'plain words', as: 'markdown', name: 'Agenda.txt' }, { actor });
  assert.equal(named.path, 'notes/Agenda.md');
  const rec = (await fs.list('history/intake')).map(async (p) => JSON.parse((await fs.read(p)).text));
  const records = await Promise.all(rec);
  assert.ok(records.some((r) => r.path === 'notes/Agenda.md' && r.chosen === true));
  assert.ok(records.some((r) => r.path === md.path && r.detected.includes('heading')));
});

test('as: overriding detection, comments, JSON and folders', async () => {
  const { folio, fs } = await make();
  // Comments and updates go to comms/.
  const [c] = await folio.add({ text: '# Notes', as: 'comment' }, { actor });
  assert.equal(c.kind, 'message');
  assert.match(c.path, /^comms\/.+\.comment\.json$/);
  // In a folder, the note goes in that folder.
  const [inFolder] = await folio.add({ text: 'Draft copy' }, { actor, folder: 'drafts' });
  assert.equal(inFolder.path, 'drafts/2026-11-09-draft-copy.txt');
  // URLs saved as text when asked.
  assert.equal((await folio.add({ text: 'https://example.com', as: 'text' }, { actor }))[0].kind, 'note');
  // Pasted JSON is a JSON file; records are data.
  const [json] = await folio.add({ text: '{ "setting": true }' }, { actor });
  assert.equal(json.path, 'attachments/2026-11-09-pasted.json');
  assert.equal((await fs.read(json.path)).text, '{ "setting": true }');
  const [records] = await folio.add({ text: JSON.stringify([{ id: 1, email: 'a@b.example' }, { id: 2, email: 'c@d.example' }]) }, { actor });
  assert.equal(records.kind, 'data');
  // JSON kept as notes when asked.
  assert.match((await folio.add({ text: '{"a":1}', as: 'text' }, { actor }))[0].path, /\.txt$/);
  assert.throws(() => classify({ text: 'not json', as: 'json' }), ValidationError);
  assert.throws(() => classify({ text: 'x', as: 'spreadsheet' }), ValidationError);
  // A dropped text file can be given another extension.
  const [retyped] = await folio.add({ name: 'readme.txt', data: new TextEncoder().encode('# Hi'), as: 'markdown' }, { actor });
  assert.equal(retyped.path, 'attachments/readme.md');
  await assert.rejects(folio.add({ name: 'shot.png', data: new Uint8Array([1, 2]), as: 'markdown' }, { actor }), ValidationError);
});

test('intakeChoices: what will happen and what else it could be', () => {
  const md = intakeChoices({ text: '# Title\n\n- a\n- b' });
  assert.equal(md.as, 'markdown');
  assert.match(md.label, /Markdown.*detected/);
  assert.deepEqual(md.choices.map((c) => c.as), ['markdown', 'html', 'text', 'comment', 'update']);
  const asComment = intakeChoices({ text: 'hello', as: 'comment' });
  assert.deepEqual([asComment.as, asComment.where], ['comment', 'comms/']);
  const chosen = intakeChoices({ text: 'hello', as: 'html' });
  assert.equal(chosen.as, 'html');
  assert.equal(intakeChoices({ text: '{"a": 1}' }).as, 'json');
  assert.equal(intakeChoices({ url: 'https://example.com' }).kind, 'link');
});

test('setTextFormat renames a note and follows the folio\'s links', async () => {
  const { folio, fs } = await make();
  const [n] = await folio.add({ text: 'Plain *looking* text', as: 'markdown' }, { actor, folder: 'docs' });
  await folio.updateManifest({ links: [{ type: 'attachment', path: n.path }] });
  const r = await folio.setTextFormat(n.path, 'html', { actor });
  assert.equal(r.path, 'docs/2026-11-09-plain-looking-text.html');
  assert.equal(await fs.exists(n.path), false);
  assert.equal((await fs.read(r.path)).text, 'Plain *looking* text\n');
  assert.equal((await folio.manifest()).manifest.links[0].path, r.path);
  assert.equal((await folio.setTextFormat(r.path, 'html')).changed, false);
  await assert.rejects(folio.setTextFormat('README.md', 'text'), ValidationError);
  await assert.rejects(folio.setTextFormat('folio.json', 'text'), ValidationError);
  // Root-level notes can be retyped too.
  await fs.write('ideas.txt', '# Ideas');
  assert.equal((await folio.setTextFormat('ideas.txt', 'markdown')).path, 'ideas.md');
});

test('nested folios: a folio inside a folio keeps its own files', async () => {
  const fs = new MemoryFs();
  await Folio.init(fs, { title: 'Parent', now });
  await fs.write('phase-2/folio.json', JSON.stringify({ format: 'folio', format_revision: 1, id: 'fol-child', title: 'Phase 2', status: 'active' }));
  await fs.write('phase-2/README.md', '# Phase 2');
  await fs.write('phase-2/notes/secret.md', 'needle');
  await fs.write('sources/uploads/kit/folio.json', '{}'); // inside a reserved folder: just a file
  await fs.write('notes/a.md', 'needle');
  assert.deepEqual(await nestedFolioDirs(fs), ['phase-2']);
  const parent = await Folio.open(fs, { nested: 'detect', now });
  assert.deepEqual(parent.nested, ['phase-2']);
  assert.ok(!(await parent.fs.list()).some((p) => p.startsWith('phase-2/')));
  assert.deepEqual((await parent.search('needle')).map((h) => h.path), ['notes/a.md']);
  assert.equal(await parent.fs.read('phase-2/notes/secret.md'), null);
  await assert.rejects(parent.fs.write('phase-2/notes/x.md', 'x'), /folio inside this one/);
  await assert.rejects(parent.add({ text: 'x' }, { folder: 'phase-2' }), /folio inside this one/);
  assert.equal((await parent.validate()).ok, true);
  // The child opens on its own.
  const { MemoryFs: _ } = await import('../src/index.js');
  const childFs = { read: (p) => fs.read(`phase-2/${p}`), write: (p, d, o) => fs.write(`phase-2/${p}`, d, o), exists: (p) => fs.exists(`phase-2/${p}`), list: async (pre = '') => (await fs.list(`phase-2/${pre}`)).map((p) => p.slice(8)), remove: (p) => fs.remove(`phase-2/${p}`) };
  const child = await Folio.open(childFs);
  assert.equal((await child.manifest()).manifest.title, 'Phase 2');
  assert.deepEqual((await child.search('needle')).map((h) => h.path), ['notes/secret.md']);
});

test('folio status: standard statuses, custom ones allowed with a warning, setStatus tells the host', async () => {
  const { FOLIO_STATUSES, folioStatusLabel, validateManifest } = await import('../src/index.js');
  assert.deepEqual(FOLIO_STATUSES, ['draft', 'backlog', 'planned', 'active', 'waiting', 'review', 'completed', 'archived']);
  assert.equal(folioStatusLabel('active'), 'In Progress');
  assert.equal(folioStatusLabel('blocked-on-legal'), 'Blocked on legal');
  const fs = new MemoryFs();
  const seen = [];
  await Folio.init(fs, { title: 'Board', now });
  const folio = await Folio.open(fs, { now, onManifest: (m) => seen.push(m.status) });
  await folio.setStatus('review');
  assert.equal((await folio.manifest()).manifest.status, 'review');
  await folio.setStatus('Blocked-On-Legal');
  assert.deepEqual(seen, ['review', 'blocked-on-legal']);
  assert.deepEqual(validateManifest((await folio.manifest()).manifest).map((p) => p.level), ['warning']);
  await assert.rejects(folio.setStatus('Not a status!'), ValidationError);
});

test('comms: one folder for all the conversation, in order; assets apart', async () => {
  const fs = new MemoryFs();
  let clock = 0;
  const tick = () => new Date(Date.UTC(2026, 10, 9, 15, 0, clock++)).toISOString();
  const folio = await Folio.init(fs, { title: 'Comms', now: tick });
  folio.now = tick;
  const a = await folio.comment('Kickoff: M+R to confirm the geography split', { actor });
  assert.match(a.path, /^comms\/2026-11-09-150002-kickoff-m-r-to-confirm-the-geography-spl\.comment\.json$/);
  await folio.post('update', 'On track for Friday', { actor });
  await folio.post('agent', 'Scanned 3 tables; no PII found', { actor: { type: 'agent', id: 'agent:claude', on_behalf_of: 'sam@example.com' } });
  await folio.add({ name: 'm.eml', data: new TextEncoder().encode('From: Pat <pat@x.example>\r\nSubject: Split\r\nDate: Mon, 09 Nov 2026 15:00:10 +0000\r\n\r\nOr country,state | city,zip\r\n') }, { actor });
  await folio.add({ text: 'Status: waiting on M+R', as: 'update' }, { actor });
  const [shot] = await folio.add({ name: 'shot.png', data: new Uint8Array([1]) }, { actor });
  assert.equal(shot.path, 'attachments/shot.png');
  const all = await folio.comms();
  assert.deepEqual(all.map((m) => m.kind), ['comment', 'update', 'agent', 'update', 'email']); // in time order: the email is dated 15:00:10
  assert.ok(all.every((m) => m.path.startsWith('comms/')));
  assert.equal(all[2].author.on_behalf_of, 'sam@example.com');
  assert.equal(all[4].subject, 'Split');
  assert.equal((await folio.validate()).ok, true);
  // Comments do not change folio.json.
  assert.deepEqual((await folio.history()).map((h) => h.type), ['created']);
});

test('upgradeLayout moves an older folio: emails to comms/, uploads to attachments/', async () => {
  const fs = new MemoryFs();
  const folio = await Folio.init(fs, { title: 'Old', now });
  await fs.write('sources/email/2026-11-02-hello-abcd1234.eml', 'From: a@b.example\r\nSubject: Hello\r\nDate: Mon, 02 Nov 2026 10:00:00 +0000\r\n\r\nHi\r\n');
  await fs.write('sources/email/attachments/2026-11-02-hello-abcd1234/a.pdf', '%PDF');
  await fs.write('sources/uploads/brief.pdf', '%PDF');
  assert.deepEqual((await folio.comms()).map((m) => m.kind), ['email']); // older layouts still read
  const r = await folio.upgradeLayout({ actor });
  assert.equal(r.moved, 3);
  assert.deepEqual(r.moves['sources/uploads/brief.pdf'], 'attachments/brief.pdf');
  assert.equal(await fs.exists('comms/2026-11-02-hello-abcd1234.eml'), true);
  assert.equal(await fs.exists('attachments/2026-11-02-hello-abcd1234/a.pdf'), true);
  assert.deepEqual(await fs.list('sources'), []);
  assert.equal((await folio.emails()).length, 1);
  assert.equal((await folio.upgradeLayout()).moved, 0);
});

test('upgradeLayout turns work items from the older layout into folios inside the folio, keeping everything they had', async () => {
  const fs = new MemoryFs();
  const folio = await Folio.init(fs, { title: 'Support', now });
  const ev = (id, revision, type, extra = {}) => fs.write(`tickets/${id}/events/${String(revision).padStart(6, '0')}.json`, JSON.stringify({ ticket: id, revision, at: `2026-11-0${revision}T10:00:00.000Z`, actor: { type: 'user', id: 'pat@x.example' }, via: 'web', type, ...extra }));
  const ticket = (t) => fs.write(`tickets/${t.id}/ticket.json`, JSON.stringify({ type: 'support', priority: 'normal', revision: 1, created_at: '2026-11-01T10:00:00.000Z', updated_at: '2026-11-01T10:00:00.000Z', ...t }));
  await fs.write('sources/email/2026-11-01-reset-loop-1234abcd.eml', 'From: donor-ops@client.example\r\nSubject: Reset loop\r\nDate: Sun, 01 Nov 2026 09:00:00 +0000\r\n\r\nIt loops.\r\n');
  await ticket({ id: 'TK-001', title: 'Password reset link loops', status: 'in_progress', priority: 'high', labels: ['auth'], owner: 'sam@x.example', links: [{ type: 'source', label: 'Email: Reset loop', path: 'sources/email/2026-11-01-reset-loop-1234abcd.eml' }, { type: 'url', url: 'https://github.com/a/b/issues/3' }] });
  await fs.write('tickets/TK-001/description.md', 'Safari only.\n');
  await fs.write('tickets/TK-001/attachments/shot.png', 'PNG');
  await ev('TK-001', 1, 'created');
  await ev('TK-001', 2, 'comment', { comment: 'Reproduced on iOS' });
  await ev('TK-001', 3, 'updated', { changes: { status: { from: 'open', to: 'in_progress' } } });
  await ticket({ id: 'TK-002', title: 'Check iOS 18', status: 'closed', resolution: 'fixed', relationships: [{ type: 'parent', target: 'TK-001' }] });
  await ticket({ id: 'TK-003', title: 'Release the fix', status: 'open', relationships: [{ type: 'blocked_by', target: 'TK-001' }] });
  await ticket({ id: 'TK-004', title: 'Old idea', status: 'cancelled' });
  const r = await folio.upgradeLayout({ actor });
  assert.equal(r.converted.length, 4);
  assert.match(r.summary, /Turned 4 items from the older layout into folios/);
  assert.deepEqual(await fs.list('tickets'), []);
  const byAlias = Object.fromEntries(r.converted.map((c) => [c.alias, c]));
  assert.equal(byAlias['TK-001'].dir, 'password-reset-link-loops');
  assert.equal(byAlias['TK-002'].dir, 'password-reset-link-loops/check-ios-18'); // a subtask inside its task
  const reset = folio.child(byAlias['TK-001'].dir);
  const m = (await reset.manifest()).manifest;
  assert.deepEqual([m.title, m.type, m.status, m.priority, m.tags, m.owner, m.aliases], ['Password reset link loops', 'support', 'active', undefined, ['auth'], 'sam@x.example', ['TK-001']]);
  assert.deepEqual(m.links, [{ type: 'url', url: 'https://github.com/a/b/issues/3' }]);
  assert.equal((await reset.fs.read('README.md')).text, '# Password reset link loops\n\nSafari only.\n');
  assert.equal(await reset.fs.exists('attachments/shot.png'), true);
  const said = await reset.comms();
  assert.deepEqual(said.map((x) => [x.kind, x.text || x.subject]), [['email', 'It loops.'], ['comment', 'Reproduced on iOS']]);
  assert.equal(said[1].at, '2026-11-02T10:00:00.000Z');
  assert.ok((await reset.history()).some((h) => h.ticket?.id === 'TK-001' && h.changes?.status?.to === 'in_progress'));
  const release = (await folio.child(byAlias['TK-003'].dir).manifest()).manifest;
  assert.deepEqual([release.status, release.relationships], ['backlog', [{ type: 'blocked_by', target: byAlias['TK-001'].id }]]);
  assert.deepEqual([(await folio.child(byAlias['TK-002'].dir).manifest()).manifest.status, (await folio.child(byAlias['TK-004'].dir).manifest()).manifest.resolution], ['completed', 'cancelled']);
  // The folio sees them as its folios; everything validates; running again does nothing.
  const after = await Folio.open(fs, { nested: 'detect' });
  assert.deepEqual((await after.children()).map((c) => c.title).sort(), ['Old idea', 'Password reset link loops', 'Release the fix']);
  assert.equal((await after.validate()).ok, true);
  assert.equal((await after.upgradeLayout()).converted.length, 0);
});

test('upgradeLayout clears a type only older versions used', async () => {
  const fs = new MemoryFs();
  const folio = await Folio.init(fs, { title: 'Old one', now: () => '2026-11-01T00:00:00.000Z' });
  const m = JSON.parse((await fs.read('folio.json')).text);
  m.type = LEGACY_TYPES[0];
  await fs.write('folio.json', JSON.stringify(m));
  const r = await folio.upgradeLayout();
  assert.equal(r.retyped, true);
  assert.equal((await folio.manifest()).manifest.type, undefined);
  assert.ok(!FOLIO_TYPES.includes(LEGACY_TYPES[0]));
});
