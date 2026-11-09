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
  const t = await folio.createTicket({ title: 'Launch' }, { actor });
  // On a ticket, text is a comment unless a file type is chosen.
  assert.equal((await folio.add({ text: '# Notes' }, { actor, ticket: t.id }))[0].ticket, t.id);
  const [file] = await folio.add({ text: '# Notes\n\n- one\n- two', as: 'markdown' }, { actor, ticket: t.id });
  assert.equal(file.path, `tickets/${t.id}/attachments/2026-11-09-notes.md`);
  assert.ok((await folio.getTicket(t.id)).ticket.links.some((l) => l.path === file.path));
  // In a folder, the note goes in that folder.
  const [inFolder] = await folio.add({ text: 'Draft copy' }, { actor, folder: 'drafts' });
  assert.equal(inFolder.path, 'drafts/2026-11-09-draft-copy.txt');
  // URLs saved as text when asked.
  assert.equal((await folio.add({ text: 'https://example.com', as: 'text' }, { actor }))[0].kind, 'note');
  // Pasted JSON is a JSON file; records are data.
  const [json] = await folio.add({ text: '{ "setting": true }' }, { actor });
  assert.equal(json.path, 'sources/uploads/2026-11-09-pasted.json');
  assert.equal((await fs.read(json.path)).text, '{ "setting": true }');
  const [records] = await folio.add({ text: JSON.stringify([{ id: 1, email: 'a@b.example' }, { id: 2, email: 'c@d.example' }]) }, { actor });
  assert.equal(records.kind, 'data');
  // JSON kept as notes when asked.
  assert.match((await folio.add({ text: '{"a":1}', as: 'text' }, { actor }))[0].path, /\.txt$/);
  assert.throws(() => classify({ text: 'not json', as: 'json' }), ValidationError);
  assert.throws(() => classify({ text: 'x', as: 'spreadsheet' }), ValidationError);
  // A dropped text file can be given another extension.
  const [retyped] = await folio.add({ name: 'readme.txt', data: new TextEncoder().encode('# Hi'), as: 'markdown' }, { actor });
  assert.equal(retyped.path, 'sources/uploads/readme.md');
  await assert.rejects(folio.add({ name: 'shot.png', data: new Uint8Array([1, 2]), as: 'markdown' }, { actor }), ValidationError);
});

test('intakeChoices: what will happen and what else it could be', () => {
  const md = intakeChoices({ text: '# Title\n\n- a\n- b' });
  assert.equal(md.as, 'markdown');
  assert.match(md.label, /Markdown.*detected/);
  assert.deepEqual(md.choices.map((c) => c.as), ['markdown', 'html', 'text']);
  const onTicket = intakeChoices({ text: 'hello' }, { ticket: 'TK-001' });
  assert.equal(onTicket.as, 'comment');
  assert.equal(onTicket.choices[0].as, 'comment');
  const chosen = intakeChoices({ text: 'hello', as: 'html' });
  assert.equal(chosen.as, 'html');
  assert.equal(intakeChoices({ text: '{"a": 1}' }).as, 'json');
  assert.equal(intakeChoices({ url: 'https://example.com' }).kind, 'link');
});

test('setTextFormat renames a note and follows ticket links', async () => {
  const { folio, fs } = await make();
  const t = await folio.createTicket({ title: 'Docs' }, { actor });
  const [n] = await folio.add({ text: 'Plain *looking* text', as: 'markdown' }, { actor, ticket: t.id });
  const r = await folio.setTextFormat(n.path, 'html', { actor });
  assert.equal(r.path, `tickets/${t.id}/attachments/2026-11-09-plain-looking-text.html`);
  assert.equal(await fs.exists(n.path), false);
  assert.equal((await fs.read(r.path)).text, 'Plain *looking* text\n');
  assert.ok((await folio.getTicket(t.id)).ticket.links.some((l) => l.path === r.path));
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
