import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Folio, MemoryFs, ValidationError } from '../src/index.js';

const now = () => '2026-11-16T13:51:00.000Z';
const actor = { type: 'user', id: 'chris@engine9.ai' };

test('files and folders go to the Trash, come back, and are deleted for good when it is emptied', async () => {
  const fs = new MemoryFs();
  const folio = await Folio.init(fs, { title: 'T', now, actor });
  const [note] = await folio.add({ text: 'message:%3Cabc@x.com%3E', as: 'text' }, { actor });
  await folio.add({ name: 'a.pdf', type: 'application/pdf', data: new Uint8Array([37, 80, 68, 70]) }, { actor });
  await folio.add({ name: 'b.png', type: 'image/png', data: new Uint8Array([1, 2, 3]) }, { actor });
  for (const p of ['folio.json', 'README.md', 'tasks/x/task.json']) await assert.rejects(folio.moveToTrash(p, { actor }), ValidationError);
  const e1 = await folio.moveToTrash(note.path, { actor });
  assert.equal(e1.kind, 'file');
  assert.equal(await fs.exists(note.path), false);
  const e2 = await folio.moveToTrash('attachments', { actor });
  assert.equal(e2.kind, 'folder');
  assert.deepEqual(e2.files, ['attachments/a.pdf', 'attachments/b.png']);
  assert.equal((await folio.trash()).length, 2);
  assert.equal((await folio.search('message')).some((r) => r.path.startsWith('.trash/')), false);
  // Restoring when the name is taken again gives "name 2".
  await folio.add({ name: 'a.pdf', type: 'application/pdf', data: new Uint8Array([9]) }, { actor });
  const back = await folio.restoreFromTrash(e2.id, { actor });
  assert.equal(back.path, 'attachments 2');
  assert.deepEqual((await fs.readBytes('attachments 2/a.pdf')).bytes, new Uint8Array([37, 80, 68, 70]));
  await folio.emptyTrash();
  assert.deepEqual(await folio.trash(), []);
  assert.deepEqual(await fs.list('.trash/'), []);
  await assert.rejects(folio.restoreFromTrash(e1.id), /not found|\.trash/i);
});
