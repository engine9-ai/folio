import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictError, Folio, MemoryFs, NotFoundError, ValidationError, canHoldFolio, parseEnvironment, validateFolio } from '../src/index.js';

let clock = Date.parse('2026-11-11T12:00:00.000Z');
const now = () => new Date(clock).toISOString();
const agent = { type: 'agent', id: 'claude', on_behalf_of: 'sam@acme.com' };
const make = async () => {
  clock = Date.parse('2026-11-11T12:00:00.000Z');
  const fs = new MemoryFs();
  const folio = await Folio.init(fs, { title: 'Spin up client X', now });
  return { fs, folio };
};

test('environments are platform/account, with no credentials', () => {
  assert.deepEqual(parseEnvironment('engine9/acme'), { platform: 'engine9', account_id: 'acme' });
  assert.deepEqual(parseEnvironment({ platform: 'engine9', account_id: 'acme', base_url: 'https://data.engine9.ai' }), { platform: 'engine9', account_id: 'acme', base_url: 'https://data.engine9.ai' });
  assert.throws(() => parseEnvironment('acme'), ValidationError);
  assert.throws(() => parseEnvironment(null), ValidationError);
  assert.throws(() => parseEnvironment({ platform: 'engine9', account_id: 'acme', base_url: 'https://u:p@data.engine9.ai' }), /credentials/);
});

test('a task is exactly one of path + method or flow_id, and gets its own folder in tasks/', async () => {
  const { folio, fs } = await make();
  await assert.rejects(folio.addTask({ environment: 'engine9/acme' }), /path and method/);
  await assert.rejects(folio.addTask({ environment: 'engine9/acme', flow_id: 'nightly-sync', path: 'x', method: 'y' }), /not both/);
  await assert.rejects(folio.addTask({ path: 'x', method: 'y' }), /environment/);

  const r = await folio.addTask(
    { title: 'Create database', environment: 'engine9/acme', path: '@engine9/plugins/e9workers:EchoWorker', method: 'echo', options: { message: 'hi', seconds: 1 }, within_minutes: 30, run: { flow_run_id: 'fr-1', task_run_ids: ['tr-1'] }, state: 'PENDING', definition_url: 'https://github.com/engine9-ai/skills/tree/main/e9-tasks-api' },
    { actor: agent, via: 'mcp' }
  );
  assert.match(r.id, /^tsk-/);
  assert.equal(r.path, 'tasks/create-database');
  const t = JSON.parse((await fs.read('tasks/create-database/task.json')).text);
  assert.equal(t.format, 'folio-task');
  assert.equal(t.kind, 'on_demand');
  assert.deepEqual(t.environment, { platform: 'engine9', account_id: 'acme' });
  assert.deepEqual(t.run, { flow_run_id: 'fr-1', task_run_ids: ['tr-1'] });
  assert.equal(t.complete_by, '2026-11-11T12:30:00.000Z');
  assert.deepEqual(t.state, { type: 'PENDING' });
  assert.equal(t.history.length, 1);

  // The conversation says so, pointing at the record.
  const msgs = await folio.comms();
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].kind, 'agent');
  assert.equal(msgs[0].task, 'tasks/create-database');
  assert.match(msgs[0].text, /Create database.*engine9\/acme.*fr-1/);

  // A flow; the same title again gets another folder.
  const f = await folio.addTask({ title: 'Create database', environment: 'engine9/acme', flow_id: 'install-plugins', tasks: [{ task_key: 'load', options: { table: 'person' } }] }, { announce: false });
  assert.equal(f.dir, 'create-database-2');
  assert.equal(f.task.kind, 'flow');
  assert.equal((await folio.tasks()).length, 2);
  assert.equal((await folio.comms()).length, 1);

  // tasks/ is one of Folio's own folders: no nested folios there.
  assert.equal(canHoldFolio('tasks/create-database'), false);
  assert.equal((await validateFolio(fs)).ok, true);
});

test('updating a task follows the platform: state, run ids, output; finishing posts to comms', async () => {
  const { folio, fs } = await make();
  const { id, dir } = await folio.addTask({ title: 'Install plugins', environment: 'engine9/acme', path: '@engine9/plugins/x:Worker', method: 'install', within_minutes: 10 }, { actor: agent, announce: false });

  // Options may change before it starts, not after.
  await folio.updateTask(id, { options: { plugin: 'stripe' } });
  clock += 60_000;
  let u = await folio.updateTask(dir, { state: { type: 'RUNNING', name: 'Running' }, run: { flow_run_id: 'fr-9', task_run_id: 'tr-9' } }, { actor: agent });
  assert.deepEqual(u.changed.sort(), ['run', 'start_time', 'state']);
  await assert.rejects(folio.updateTask(id, { options: { plugin: 'other' } }), /before the task starts/);
  await assert.rejects(folio.updateTask(id, { path: 'other' }), /new task/);
  await assert.rejects(folio.updateTask(id, { state: 'DONE' }), /not a task state/);

  // Overdue once past its window and not finished.
  clock += 20 * 60_000;
  assert.equal((await folio.tasks())[0].overdue, true);
  assert.equal((await folio.taskCounts()).overdue, 1);

  // Output is scrubbed and kept in output.json; large output is refused.
  await assert.rejects(folio.updateTask(id, { output: { rows: 'x'.repeat(70_000) } }), /KB/);
  u = await folio.updateTask(`tasks/${dir}`, { state: 'COMPLETED', records: 3, result: 'Installed 3 plugins', output: { installed: ['stripe', 'mailchimp', 'ga'], token: ['sk', 'live', '51H' + 'x'.repeat(24)].join('_') } }, { actor: agent });
  assert.equal(u.task.output, 'output.json');
  assert.ok(u.task.end_time);
  const out = (await folio.task(id, { output: true })).output;
  assert.deepEqual(out.installed, ['stripe', 'mailchimp', 'ga']);
  assert.ok(!JSON.stringify(out).includes('sk_live_51H'));
  assert.equal((await folio.tasks())[0].overdue, false);

  const t = (await folio.task(id)).task;
  assert.deepEqual(t.history.map((h) => h.state), ['PENDING', 'RUNNING', 'COMPLETED']);
  const msgs = await folio.comms();
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].text, /Install plugins.*completed: 3 records\. Installed 3 plugins/);
  assert.equal(msgs[0].task, `tasks/${dir}`);

  // Updating again with nothing new changes nothing; a retry back to RUNNING is recorded.
  assert.deepEqual((await folio.updateTask(id, { state: 'COMPLETED' })).changed, []);
  await folio.updateTask(id, { state: 'RUNNING', note: 'retried' });
  assert.equal((await folio.task(id)).task.history.at(-1).note, 'retried');

  // Failure: the error is kept and reported.
  const b = await folio.addTask({ environment: 'engine9/acme', flow_id: 'nightly-sync' }, { announce: false });
  await folio.updateTask(b.id, { state: 'FAILED', errors: ['Table person does not exist'] });
  assert.match((await folio.comms()).at(-1).text, /failed: Table person does not exist/);
  assert.equal((await folio.tasks({ state: 'failed' })).length, 1);
  assert.equal((await folio.tasks({ open: true })).length, 1);

  await assert.rejects(folio.task('tsk-nothere'), NotFoundError);
  // A stale etag is refused.
  const cur = await folio.task(b.id);
  await folio.updateTask(b.id, { note: 'looked at it' });
  await assert.rejects(folio.updateTask(b.id, { note: 'again' }, { ifMatch: cur.etag }), ConflictError);
  assert.equal((await validateFolio(fs)).ok, true);
});

test('overview counts tasks; validate reports a broken task record', async () => {
  const { folio, fs } = await make();
  await folio.addTask({ environment: 'engine9/acme', flow_id: 'identity-rebuild' }, { announce: false });
  const o = await folio.overview();
  assert.equal(o.tasks.total, 1);
  assert.equal(o.tasks.open, 1);
  assert.equal(o.tasks.recent[0].target, 'flow identity-rebuild');
  await fs.write('tasks/bad/task.json', JSON.stringify({ id: 'nope', title: 'x' }));
  const v = await validateFolio(fs);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => p.code === 'task_environment' && p.path === 'tasks/bad/task.json'));
});
