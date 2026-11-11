import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictError, Folio, MemoryFs, ValidationError, checklistCounts, editChecklistText, parseChecklist } from '../src/index.js';

const now = () => '2026-11-11T12:00:00.000Z';
const make = async (readme) => {
  const fs = new MemoryFs();
  const folio = await Folio.init(fs, { title: 'Launch', now, ...(readme ? { readme } : {}) });
  return { fs, folio };
};

const README = `# Launch

Why this exists.

## Checklist

- [x] Confirm launch date with Tim
- [ ] Send DNS change request
Some note in the section stays put.
* [ ] Check redirects after cutover

## Notes

- [ ] not an item: another section
\`\`\`
## Checklist
- [ ] inside a code fence
\`\`\`
`;

test('the checklist is the Markdown checkboxes under a Checklist heading, nothing else', () => {
  const { items } = parseChecklist(README);
  assert.deepEqual(items.map((i) => [i.n, i.done, i.text]), [[1, true, 'Confirm launch date with Tim'], [2, false, 'Send DNS change request'], [3, false, 'Check redirects after cutover']]);
  assert.deepEqual(checklistCounts(README), { done: 1, total: 3 });
  assert.equal(checklistCounts('# x\n\n- [ ] no heading\n'), null);
});

test('edits touch only the checklist lines; refs are numbers, text, or { n, expect }', () => {
  const r = editChecklistText(README, { check: [2], uncheck: ['confirm launch date with tim'], rename: [{ item: 3, text: 'Check  redirects\nafter cutover (all)' }], add: ['Tell support'] });
  assert.equal(r.changed, 4);
  assert.deepEqual(r.items.map((i) => [i.done, i.text]), [[false, 'Confirm launch date with Tim'], [true, 'Send DNS change request'], [false, 'Check redirects after cutover (all)'], [false, 'Tell support']]);
  assert.match(r.text, /\* \[ \] Check redirects after cutover \(all\)\n- \[ \] Tell support\n\n## Notes/);
  assert.match(r.text, /Some note in the section stays put\./);
  assert.ok(r.text.endsWith('- [ ] inside a code fence\n```\n'));
  // Removing uses the list as it was; a stale ref is refused.
  assert.deepEqual(editChecklistText(README, { remove: [1, 3] }).items.map((i) => i.text), ['Send DNS change request']);
  assert.throws(() => editChecklistText(README, { check: [{ n: 2, expect: 'Something else' }] }), /checklist changed/);
  assert.throws(() => editChecklistText(README, { check: [9] }), /no item 9/);
  assert.throws(() => editChecklistText(README, { add: ['x'.repeat(301)] }), /sub-folio/);
  assert.throws(() => editChecklistText(README, { add: Array.from({ length: 48 }, (_, i) => `item ${i}`) }), /at most 50/);
  // Nothing to change: the same text.
  assert.equal(editChecklistText(README, { check: [1] }).changed, 0);
});

test('a folio gets a checklist by adding to it; the host hears the counts; items can become sub-folios', async () => {
  const { folio, fs } = await make();
  const heard = [];
  folio.onChecklist = (c) => heard.push(c);
  assert.deepEqual((await folio.checklist()).items, []);
  await folio.editChecklist({ add: ['Confirm launch date', 'Send DNS change'] });
  const readme = (await fs.read('README.md')).text;
  assert.match(readme, /^# Launch\n\n.*\n\n## Checklist\n\n- \[ \] Confirm launch date\n- \[ \] Send DNS change\n$/s);
  let c = await folio.editChecklist({ check: ['Confirm launch date'] });
  assert.deepEqual([c.done, c.total], [1, 2]);
  assert.deepEqual(heard, [{ done: 0, total: 2 }, { done: 1, total: 2 }]);
  // Nothing posted, nothing in folio.json's history.
  assert.equal((await folio.comms()).length, 0);
  assert.equal((await folio.history()).length, 1);
  // Card numbers and credentials never get in.
  await folio.editChecklist({ add: ['Card 4539 1488 0343 6467 for the test'] });
  assert.ok(!(await fs.read('README.md')).text.includes('4539 1488'));

  // Too much for a checklist: make it a folio inside this one.
  const child = await folio.checklistItemToFolio('Send DNS change', { owner: 'robin@example.com' });
  assert.equal(child.manifest.title, 'Send DNS change');
  assert.equal(child.manifest.owner, 'robin@example.com');
  const left = (await folio.checklist()).items.map((i) => i.text);
  assert.equal(left.length, 2);
  assert.equal(left[0], 'Confirm launch date');
  const o = await folio.overview();
  assert.equal(o.checklist.total, 2);
  assert.equal(o.folios.total, 1);

  // A stale etag is refused when given; otherwise a concurrent README edit is merged.
  const { etag } = await folio.checklist();
  await fs.write('README.md', (await fs.read('README.md')).text.replace('# Launch', '# Launch!'));
  await assert.rejects(folio.editChecklist({ check: [2] }, { ifMatch: etag }), ConflictError);
  await folio.editChecklist({ check: [2] });
  assert.match((await fs.read('README.md')).text, /^# Launch!/);
  await assert.rejects(folio.editChecklist({ add: [''] }), ValidationError);
});
