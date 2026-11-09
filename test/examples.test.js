import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Folio } from '../src/folio.js';
import { NodeFs } from '../src/node-fs.js';

const examples = fileURLToPath(new URL('../examples/', import.meta.url));
const names = (await readdir(examples, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);

test('there are examples', () => assert.ok(names.length >= 2));

for (const name of names) {
  test(`example "${name}" opens and validates with no errors`, async () => {
    const folio = await Folio.open(new NodeFs(join(examples, name)), { nested: 'detect' });
    const { ok, problems } = await folio.validate();
    assert.equal(ok, true, JSON.stringify(problems, null, 2));
  });
}

test('website-refresh shows folios inside folios, blockers and readiness', async () => {
  const folio = await Folio.open(new NodeFs(join(examples, 'website-refresh')), { nested: 'detect' });
  const kids = Object.fromEntries((await folio.children()).map((c) => [c.title, c]));
  assert.deepEqual(Object.keys(kids).sort(), ['Launch readiness checklist', 'Migrate help content', 'New sign-in and account page design']);
  assert.equal(kids['Launch readiness checklist'].readiness.state, 'blocked');
  assert.equal(kids['Migrate help content'].readiness.state, 'in_progress');
  const design = await folio.child('new-sign-in-and-account-page-design');
  const [bug] = await (await Folio.open(design.root, { nested: 'detect' })).children();
  assert.equal(bug.type, 'bug');
  assert.ok(bug.relationships.some((r) => r.type === 'discovered_from'));
  assert.equal(kids['New sign-in and account page design'].readiness.state, 'blocked'); // waits on the bug
  assert.equal((await folio.repositories()).length, 3);
});
