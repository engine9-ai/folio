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

test('detectImport recognises Asana, Trello and Folio ticket lists, and nothing else', () => {
  assert.deepEqual(detectImport(ASANA), { format: 'asana', label: 'Asana', tickets: 4, subtasks: 2, sections: 1, project: 'Website refresh' });
  assert.equal(detectImport(ASANA.data).format, 'asana'); // a bare array of tasks
  assert.equal(detectImport({ data: ASANA.data[1] }).format, 'asana'); // one task from the API
  assert.equal(detectImport({ cards: [{ id: 'c1', name: 'A', idList: 'l1' }], lists: [{ id: 'l1', name: 'To do' }] }).format, 'trello');
  assert.equal(detectImport({ tickets: [{ title: 'A' }] }).format, 'folio-tickets');
  assert.equal(detectImport([{ id: 1, email: 'a@b.example' }]), null);
  assert.equal(detectImport({ data: [{ gid: '1', name: 'x' }] }), null); // gid and name alone are not enough
  assert.equal(detectImport({ setting: true }), null);
  assert.equal(detectImport(ASANA, { format: 'trello' }), null);
});

test('an Asana export becomes tickets: subtasks, sections, tags, priority, dependencies, comments', async () => {
  const { folio, fs } = await make();
  const r = await folio.import(JSON.stringify(ASANA), { actor, via: 'test', name: 'asana.json' });
  assert.equal(r.format, 'asana');
  assert.deepEqual(r.created, ['TK-001', 'TK-002', 'TK-003', 'TK-004']);
  assert.match(r.summary, /^Imported 4 tickets from Asana \(Website refresh\)$/);
  const views = await folio.ticketViews();
  const by = (title) => views.find((t) => t.title === title);
  const page = by('Redesign donate page');
  assert.equal(page.status, 'in_progress'); // from the "In Progress" section
  assert.equal(page.priority, 'high');
  assert.equal(page.owner, 'Riley Chen');
  assert.equal(page.target_date, '2026-12-01');
  assert.deepEqual(page.tags, ['In Progress', 'Design']);
  assert.deepEqual(page.external, { source: 'asana', id: '1201', url: 'https://app.asana.com/0/42/1201', created_at: '2026-10-01T10:00:00.000Z' });
  assert.deepEqual(page.links, [{ type: 'url', label: 'Asana task', url: 'https://app.asana.com/0/42/1201' }]);
  const approve = by('Approve new brand colours');
  assert.equal(approve.type, 'review');
  assert.equal(approve.priority, 'low');
  assert.equal(approve.tags.length, 0); // "Untitled section" is not a tag
  assert.deepEqual(page.relationships.find((x) => x.type === 'blocked_by'), { type: 'blocked_by', target: approve.id });
  const hero = by('Pick hero image');
  assert.deepEqual(hero.relationships, [{ type: 'parent', target: page.id }]);
  assert.equal(hero.status, 'closed');
  assert.equal(hero.resolution, 'completed');
  assert.deepEqual(page.children.sort(), [hero.id, by('Write alt text').id].sort());
  // Description: notes scrubbed of card numbers, plus where it came from.
  const desc = (await fs.read(`tickets/${page.id}/description.md`)).text;
  assert.ok(!desc.includes('4539 1488'));
  assert.match(desc, /Assignee in Asana: Riley Chen/);
  assert.match(desc, /Estimate: 5/);
  assert.match(desc, /Imported from Asana: https:\/\/app\.asana\.com\/0\/42\/1201/);
  assert.match((await fs.read(`tickets/${by('Write alt text').id}/description.md`)).text, /Alt text for all images/);
  // Comments are history; system stories are not.
  const events = await folio.ticketEvents(page.id);
  assert.deepEqual(events.map((e) => e.type), ['created', 'comment']);
  assert.equal(events[1].comment, '(Asana, Pat, 2026-10-02) Waiting on copy from the client');
  assert.equal(page.revision, 2);
  // A record of the import, and a valid folio.
  const report = JSON.parse((await fs.read(r.path)).text);
  assert.equal(report.created.length, 4);
  assert.equal(report.original_name, 'asana.json');
  assert.deepEqual((await folio.validate()).problems.filter((p) => p.level === 'error'), []);
});

test('importing the same export again skips what is already there', async () => {
  const { folio } = await make();
  await folio.import(ASANA, { actor });
  const more = structuredClone(ASANA);
  more.data.push({ gid: '1299', resource_type: 'task', name: 'New task', completed: false, memberships: [], parent: { gid: '1201' } });
  const again = await folio.import(more, { actor });
  assert.deepEqual(again.created, ['TK-005']);
  assert.equal(again.duplicates, 4);
  assert.deepEqual((await folio.getTicket('TK-005')).ticket.relationships, [{ type: 'parent', target: 'TK-001' }]);
  assert.deepEqual(await folio.import(ASANA, { dryRun: true }), { format: 'asana', label: 'Asana', tickets: 4, subtasks: 2, sections: 1, project: 'Website refresh', would_create: 0, duplicates: 4 });
});

test('dependency loops are dropped, not imported', async () => {
  const { folio } = await make();
  const loop = { data: [
    { gid: 'a', resource_type: 'task', name: 'A', dependencies: [{ gid: 'b' }] },
    { gid: 'b', resource_type: 'task', name: 'B', dependencies: [{ gid: 'a' }] },
  ] };
  const r = await folio.import(loop, { actor });
  assert.equal(r.created.length, 2);
  const rels = (await folio.listTickets()).flatMap((t) => t.relationships);
  assert.equal(rels.length, 1);
  assert.equal((await folio.validate()).ok, true);
});

test('dropping or pasting an export imports it; "as" keeps it as a file instead', async () => {
  const { folio, fs } = await make();
  const bytes = new TextEncoder().encode(JSON.stringify(ASANA));
  assert.equal(classify({ name: 'project.json', type: 'application/json', data: bytes }).kind, 'import');
  const choices = intakeChoices({ text: JSON.stringify(ASANA) });
  assert.equal(choices.as, 'import');
  assert.match(choices.label, /Asana export: 4 tickets/);
  assert.deepEqual(choices.choices.map((c) => c.as), ['import', 'json']);
  const [r] = await folio.add({ name: 'project.json', type: 'application/json', data: bytes }, { actor });
  assert.equal(r.kind, 'import');
  assert.equal(r.created.length, 4);
  // Pasted, again: all duplicates.
  const [p] = await folio.add({ text: JSON.stringify(ASANA) }, { actor });
  assert.equal(p.duplicates, 4);
  // Kept as a file (it is a list of records, so it is summarised as data).
  const [kept] = await folio.add({ name: 'project.json', type: 'application/json', data: bytes, as: 'file' }, { actor });
  assert.equal(kept.kind, 'file');
  assert.equal((await folio.listTickets()).length, 4);
  assert.throws(() => classify({ text: '{"a":1}', as: 'import' }), /not an export Folio can import/);
  void fs;
});

test('imported on a ticket: the new tickets were discovered from it', async () => {
  const { folio } = await make();
  const t = await folio.createTicket({ title: 'Plan the refresh' }, { actor });
  await folio.add({ text: JSON.stringify({ tickets: [{ title: 'One' }, { title: 'Two', status: 'closed' }] }) }, { actor, ticket: t.id });
  const two = (await folio.listTickets()).find((x) => x.title === 'Two');
  assert.equal(two.resolution, 'completed');
  assert.ok(two.relationships.some((r) => r.type === 'discovered_from' && r.target === t.id));
});

test('a Trello board export becomes tickets', async () => {
  const { folio } = await make();
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
  const [a, b] = await folio.ticketViews();
  assert.equal(a.status, 'in_progress');
  assert.equal(a.priority, 'urgent');
  assert.deepEqual(a.tags, ['Doing', 'Copy']);
  assert.equal(a.target_date, '2026-11-20');
  assert.equal(b.status, 'closed');
  assert.equal((await folio.ticketEvents(a.id))[1].comment, '(Trello, Pat, 2026-11-01) Draft is in the doc');
});

test('import limits and errors', async () => {
  const { folio } = await make();
  await assert.rejects(folio.import('not json'), ValidationError);
  await assert.rejects(folio.import({ setting: 1 }), /not an export/);
  await assert.rejects(folio.import({ tickets: Array.from({ length: 501 }, (_, i) => ({ title: `T${i}` })) }), /up to 500/);
});
