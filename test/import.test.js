import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Folio, MemoryFs, ValidationError, classify, detectImport, intakeChoices } from '../src/index.js';

const now = () => '2026-11-09T15:00:00.000Z';
const actor = { type: 'user', id: 'sam@example.com' };
const make = async () => {
  const fs = new MemoryFs();
  return { fs, folio: await Folio.init(fs, { title: 'Imports', now }) };
};

// Shaped like Asana's project JSON export ("Export → JSON"): { data: [task] } with full task records.
const ASANA = {
  data: [
    {
      gid: '1201',
      resource_type: 'task',
      name: 'Redesign donate page',
      notes: 'The donate page needs the new brand.\nDonor card 4539 1488 0343 6467 was in the report.',
      completed: false,
      assignee: { gid: '9', name: 'Riley Chen', resource_type: 'user' },
      due_on: '2026-12-01',
      created_at: '2026-10-01T10:00:00.000Z',
      permalink_url: 'https://app.asana.com/0/42/1201',
      memberships: [{ project: { gid: '42', name: 'Website refresh' }, section: { gid: '7', name: 'In Progress' } }],
      tags: [{ gid: '3', name: 'Design' }],
      custom_fields: [
        { gid: 'p', name: 'Priority', type: 'enum', enum_value: { name: 'High' } },
        { gid: 'e', name: 'Estimate', type: 'number', number_value: 5, display_value: '5' },
      ],
      dependencies: [{ gid: '1202' }],
      stories: [
        { gid: 's1', type: 'comment', resource_subtype: 'comment_added', text: 'Waiting on copy from the client', created_by: { name: 'Pat' }, created_at: '2026-10-02T09:00:00.000Z' },
        { gid: 's2', type: 'system', resource_subtype: 'assigned', text: 'assigned to Riley' },
      ],
      subtasks: [
        { gid: '1203', resource_type: 'task', name: 'Pick hero image', notes: '', completed: true, completed_at: '2026-10-05T00:00:00.000Z', memberships: [] },
        { gid: '1204', resource_type: 'task', name: 'Write alt text', html_notes: '<body>Alt text for <strong>all</strong> images</body>', completed: false, memberships: [] },
      ],
    },
    {
      gid: '1202',
      resource_type: 'task',
      name: 'Approve new brand colours',
      resource_subtype: 'approval',
      notes: '',
      completed: false,
      assignee: null,
      memberships: [{ project: { gid: '42', name: 'Website refresh' }, section: { gid: '8', name: 'Untitled section' } }],
      tags: [],
      custom_fields: [{ gid: 'p', name: 'Priority', type: 'enum', enum_value: { name: 'Low' } }],
    },
  ],
};

test('detectImport recognises Asana, Trello and Folio lists, and nothing else', () => {
  assert.deepEqual(detectImport(ASANA), { format: 'asana', label: 'Asana', items: 4, sub_items: 2, sections: 1, project: 'Website refresh' });
  assert.equal(detectImport(ASANA.data).format, 'asana'); // a bare array of tasks
  assert.equal(detectImport({ data: ASANA.data[1] }).format, 'asana'); // one task from the API
  assert.equal(detectImport({ cards: [{ id: 'c1', name: 'A', idList: 'l1' }], lists: [{ id: 'l1', name: 'To do' }] }).format, 'trello');
  assert.equal(detectImport({ folios: [{ title: 'A' }] }).format, 'folio-list');
  assert.equal(detectImport([{ id: 1, email: 'a@b.example' }]), null);
  assert.equal(detectImport({ data: [{ gid: '1', name: 'x' }] }), null); // gid and name alone are not enough
  assert.equal(detectImport({ setting: true }), null);
  assert.equal(detectImport(ASANA, { format: 'trello' }), null);
});

const kids = async (fs) => (await (await Folio.open(fs, { nested: 'detect' })).descendants());

test('an Asana export becomes folios: sub-items inside their parent, sections, tags, dependencies, comments', async () => {
  const { folio, fs } = await make();
  const r = await folio.import(JSON.stringify(ASANA), { actor, via: 'test', name: 'asana.json' });
  assert.equal(r.format, 'asana');
  assert.equal(r.created.length, 4);
  assert.match(r.summary, /^Imported 4 folios from Asana \(Website refresh\)$/);
  const all = await kids(fs);
  const by = (title) => all.find((d) => d.manifest.title === title);
  const page = by('Redesign donate page');
  assert.equal(page.dir, 'redesign-donate-page');
  const m = page.manifest;
  assert.deepEqual([m.type, m.status, m.priority, m.owner, m.target_date], ['action', 'active', undefined, 'Riley Chen', '2026-12-01']);
  assert.deepEqual(m.tags, ['In Progress', 'Design']);
  assert.deepEqual(m.external, { source: 'asana', id: '1201', url: 'https://app.asana.com/0/42/1201', created_at: '2026-10-01T10:00:00.000Z' });
  assert.deepEqual(m.links, [{ type: 'url', label: 'Asana', url: 'https://app.asana.com/0/42/1201' }]);
  const approve = by('Approve new brand colours').manifest;
  assert.deepEqual([approve.type, approve.priority, approve.tags], ['review', undefined, undefined]); // "Untitled section" is not a tag
  assert.deepEqual(m.relationships, [{ type: 'blocked_by', target: approve.id }]);
  const hero = by('Pick hero image');
  assert.equal(hero.dir, 'redesign-donate-page/pick-hero-image'); // inside its parent
  assert.deepEqual([hero.manifest.status, hero.manifest.resolution], ['completed', 'completed']);
  // README: notes scrubbed of card numbers, plus where it came from.
  const desc = (await fs.read(`${page.dir}/README.md`)).text;
  assert.ok(!desc.includes('4539 1488'));
  assert.match(desc, /Assignee in Asana: Riley Chen/);
  assert.match(desc, /Estimate: 5/);
  assert.match(desc, /Imported from Asana: https:\/\/app\.asana\.com\/0\/42\/1201/);
  assert.match((await fs.read(`${by('Write alt text').dir}/README.md`)).text, /Alt text for all images/);
  // Comments go to the folio's comms/, dated when they were written; system stories are not kept.
  const said = await folio.child(page.dir).comms();
  assert.deepEqual(said.map((x) => [x.kind, x.text, x.at]), [['comment', '(Asana, Pat, 2026-10-02) Waiting on copy from the client', '2026-10-02T09:00:00.000Z']]);
  assert.match(said[0].path, /^comms\/2026-10-02-090000-asana-pat-2026-10-02-waiting-on-copy-fro\.comment\.json$/);
  assert.deepEqual(said[0].imported, { source: 'asana', author: 'Pat', at: '2026-10-02T09:00:00.000Z' });
  // The outer folio sees its folios and their readiness; a record of the import; everything valid.
  const outer = await Folio.open(fs, { nested: 'detect' });
  const ov = await outer.overview();
  assert.equal(ov.folios.total, 2); // direct children; sub-items live inside their parent
  assert.deepEqual(ov.ready.map((x) => x.title), ['Approve new brand colours']);
  const report = JSON.parse((await fs.read(r.path)).text);
  assert.equal(report.created.length, 4);
  assert.equal(report.original_name, 'asana.json');
  assert.deepEqual((await outer.validate()).problems.filter((p) => p.level === 'error'), []);
});

test('importing the same export again skips what is already there', async () => {
  const { folio, fs } = await make();
  await folio.import(ASANA, { actor });
  const more = structuredClone(ASANA);
  more.data.push({ gid: '1299', resource_type: 'task', name: 'New task', completed: false, memberships: [], parent: { gid: '1201' } });
  const again = await folio.import(more, { actor });
  assert.deepEqual(again.created.map((c) => c.dir), ['redesign-donate-page/new-task']);
  assert.equal(again.duplicates, 4);
  assert.equal((await kids(fs)).length, 5);
  assert.deepEqual(await folio.import(ASANA, { dryRun: true }), { format: 'asana', label: 'Asana', items: 4, sub_items: 2, sections: 1, project: 'Website refresh', would_create: 0, duplicates: 4 });
});

test('dependency loops are dropped, not imported', async () => {
  const { folio, fs } = await make();
  const loop = { data: [
    { gid: 'a', resource_type: 'task', name: 'A', dependencies: [{ gid: 'b' }] },
    { gid: 'b', resource_type: 'task', name: 'B', dependencies: [{ gid: 'a' }] },
  ] };
  const r = await folio.import(loop, { actor });
  assert.equal(r.created.length, 2);
  assert.equal((await kids(fs)).flatMap((d) => d.manifest.relationships || []).length, 1);
  assert.equal((await (await Folio.open(fs, { nested: 'detect' })).validate()).ok, true);
});

test('dropping or pasting an export imports it; "as" keeps it as a file instead', async () => {
  const { folio, fs } = await make();
  const bytes = new TextEncoder().encode(JSON.stringify(ASANA));
  assert.equal(classify({ name: 'project.json', type: 'application/json', data: bytes }).kind, 'import');
  const choices = intakeChoices({ text: JSON.stringify(ASANA) });
  assert.equal(choices.as, 'import');
  assert.match(choices.label, /Asana export: 4 items/);
  assert.deepEqual(choices.choices.map((c) => c.as), ['import', 'json']);
  const [r] = await folio.add({ name: 'project.json', type: 'application/json', data: bytes }, { actor });
  assert.equal(r.kind, 'import');
  assert.equal(r.created.length, 4);
  // Pasted, again: all duplicates.
  const [p] = await folio.add({ text: JSON.stringify(ASANA) }, { actor });
  assert.equal(p.duplicates, 4);
  // Kept as a file.
  const [kept] = await folio.add({ name: 'project.json', type: 'application/json', data: bytes, as: 'file' }, { actor });
  assert.equal(kept.kind, 'file');
  assert.equal((await kids(fs)).length, 4);
  assert.throws(() => classify({ text: '{"a":1}', as: 'import' }), /not an export Folio can import/);
});

test('a Folio list: statuses, types (ticket among them), custom types and blockers by key', async () => {
  const { folio, fs } = await make();
  await folio.import({ folios: [{ id: 'a', title: 'One', type: 'research-spike' }, { id: 'b', title: 'Two', type: 'Tickets', status: 'completed', blocked_by: ['a'] }, { title: 'Three', status: 'review' }] }, { actor });
  const all = await kids(fs);
  const get = (t) => all.find((d) => d.manifest.title === t).manifest;
  assert.equal(get('One').type, 'research-spike');
  assert.deepEqual([get('Two').type, get('Two').status, get('Two').resolution, get('Two').relationships], ['ticket', 'completed', 'completed', [{ type: 'blocked_by', target: get('One').id }]]);
  assert.equal(get('Three').status, 'review');
});

test('a Trello board export becomes folios', async () => {
  const { folio, fs } = await make();
  const board = {
    name: 'Launch board',
    lists: [{ id: 'l1', name: 'Doing' }, { id: 'l2', name: 'Done' }],
    labels: [{ id: 'g', name: 'Urgent', color: 'red' }, { id: 'h', name: 'Copy', color: 'blue' }],
    cards: [
      { id: 'c1', name: 'Write launch email', desc: 'Short and warm', idList: 'l1', idLabels: ['g', 'h'], due: '2026-11-20T17:00:00.000Z', shortUrl: 'https://trello.com/c/abc' },
      { id: 'c2', name: 'Pick a date', desc: '', idList: 'l2', idLabels: [] },
    ],
    actions: [{ type: 'commentCard', date: '2026-11-01T00:00:00.000Z', data: { card: { id: 'c1' }, text: 'Draft is in the doc' }, memberCreator: { fullName: 'Pat' } }],
  };
  const r = await folio.import(board, { actor });
  assert.match(r.summary, /from Trello \(Launch board\)/);
  const all = await kids(fs);
  const a = all.find((d) => d.manifest.title === 'Write launch email');
  const b = all.find((d) => d.manifest.title === 'Pick a date').manifest;
  assert.deepEqual([a.manifest.status, a.manifest.priority, a.manifest.tags, a.manifest.target_date], ['active', undefined, ['Doing', 'Urgent', 'Copy'], '2026-11-20']);
  assert.equal(b.status, 'completed');
  assert.equal(a.manifest.type, 'action');
  assert.equal((await folio.child(a.dir).comms())[0].text, '(Trello, Pat, 2026-11-01) Draft is in the doc');
});

test('import limits and errors', async () => {
  const { folio } = await make();
  await assert.rejects(folio.import('not json'), ValidationError);
  await assert.rejects(folio.import({ setting: 1 }), /not an export/);
  await assert.rejects(folio.import({ folios: Array.from({ length: 501 }, (_, i) => ({ title: `T${i}` })) }), /up to 500/);
});
