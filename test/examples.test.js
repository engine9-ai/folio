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
    const folio = await Folio.open(new NodeFs(join(examples, name)));
    const { ok, problems } = await folio.validate();
    assert.equal(ok, true, JSON.stringify(problems, null, 2));
  });
}

test('website-refresh shows hierarchy, blockers and a feedback-derived ticket', async () => {
  const folio = await Folio.open(new NodeFs(join(examples, 'website-refresh')));
  const by = Object.fromEntries((await folio.ticketViews()).map((t) => [t.id, t]));
  assert.equal(by['TK-004'].readiness.state, 'blocked');
  assert.deepEqual(by['TK-001'].children.sort(), ['TK-002', 'TK-003', 'TK-004']);
  assert.ok(by['TK-005'].links.some((l) => l.type === 'feedback'));
  assert.equal((await folio.repositories()).length, 3);
});
