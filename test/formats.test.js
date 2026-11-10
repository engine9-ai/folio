import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Folio, MemoryFs, ValidationError, classify, detectTextFormat, intakeChoices, nestedFolioDirs, titleOfText } from '../src/index.js';

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
