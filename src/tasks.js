import { ValidationError } from './errors.js';
import { scrubText } from './privacy.js';
import { slugify } from './intake.js';

/**
 * Tasks: well-defined work run somewhere else, with a copy kept in the folio (SPEC 5.8).
 *
 * A task is not open-ended ("get the groceries", "research this"). It is one run of a named piece of work on an
 * execution platform, with a definite path/name, options and output, that completes or fails within a known time
 * window. The definition is the platform's: Folio copies the engine9 task model (Task API, engine9-ai/skills
 * e9-tasks-api), so an agent can record what it scheduled in the platform's own words:
 *
 *   on demand   one worker method: `path` + `method` (engine9 POST /tasks/schedule)
 *   flow        a predefined flow: `flow_id` (its slug, or a remote dataflow id), with optional per-step
 *               overrides `tasks: [{ task_key, options }]` (engine9 POST /flow_runs/)
 *
 * The platform runs it and keeps the logs. The folio keeps the record people and later agents need: what was
 * asked, where, by whom, the run ids to look it up again, its state, and the (small) result.
 *
 *   tasks/
 *     create-database/            one folder per task (tasks may become folios later; a folder keeps that open)
 *       task.json                 definition, environment, run ids, state, history
 *       output.json               the worker's JSON output, when kept (small: samples, not result sets)
 *
 * task.json:
 *   { format: "folio-task", format_revision, id: "tsk-…", title, summary?, description?,
 *     environment: { platform: "engine9", account_id: "acme", base_url?, connection? },
 *     kind: "on_demand" | "flow", path?, method?, flow_id?, tasks?: [{ task_key, options }], options?,
 *     tracking_code?, start_after?, complete_by?, definition_url?,
 *     run?: { flow_run_id?, task_run_ids?: [], url?, log_link? },
 *     state: { type: PENDING|SCHEDULED|RUNNING|PAUSED|COMPLETED|FAILED|CANCELLED|CRASHED, name? },
 *     start_time?, end_time?, records?, errors?: [{ level, message, ts }], result?, output?: "output.json",
 *     created_at, updated_at, created_by, history: [{ at, state, actor, via, note? }] }
 *
 * Live state on the platform (allowed_actions, checkpoints, logs) is never copied in; it is looked up there with
 * the run ids.
 */

export const TASKS_DIR = 'tasks';
export const TASK_FILE = 'task.json';
export const TASK_OUTPUT_FILE = 'output.json';
export const TASK_FORMAT = 'folio-task';
export const TASK_FORMAT_REVISION = 1;
export const TASK_KINDS = Object.freeze(['on_demand', 'flow']);
/** The engine9 (Prefect) state types, in the order a run normally moves through them. */
export const TASK_STATES = Object.freeze(['PENDING', 'SCHEDULED', 'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED', 'CRASHED']);
export const TERMINAL_TASK_STATES = Object.freeze(['COMPLETED', 'FAILED', 'CANCELLED', 'CRASHED']);
export const TASK_STATE_LABELS = Object.freeze({ PENDING: 'Pending', SCHEDULED: 'Scheduled', RUNNING: 'Running', PAUSED: 'Paused', COMPLETED: 'Completed', FAILED: 'Failed', CANCELLED: 'Cancelled', CRASHED: 'Crashed' });
/** Output kept in the folio, as JSON text. Bigger results stay on the platform (SPEC 3.7). */
export const MAX_TASK_OUTPUT = 64 * 1024;
export const MAX_TASK_HISTORY = 100;
const MAX_ERRORS = 20;
const PLATFORM = /^[a-z][a-z0-9_-]{0,39}$/;
const ID_ALPHABET = 'abcdefghjkmnpqrstvwxyz23456789';

export const isTerminalState = (s) => TERMINAL_TASK_STATES.includes(String(s?.type ?? s ?? '').toUpperCase());
export const taskStateLabel = (s) => TASK_STATE_LABELS[String(s?.type ?? s ?? '').toUpperCase()] || String(s?.type ?? s ?? 'Unknown');

export function newTaskId(random = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  let s = '';
  for (const b of random(6)) s += ID_ALPHABET[b % ID_ALPHABET.length];
  return `tsk-${s}`;
}
export const isTaskId = (s) => typeof s === 'string' && /^tsk-[a-z0-9]{4,20}$/.test(s);

const str = (v, max = 500) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const cleanText = (v, max = 4000) => {
  const s = str(v, max);
  return s === undefined ? undefined : scrubText(s).text;
};
const iso = (v, field) => {
  if (v === undefined || v === null || v === '') return undefined;
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new ValidationError(`${field} must be a date and time (ISO 8601)`);
  return new Date(t).toISOString();
};

/** Card numbers and credentials out of every string in a JSON value (SPEC 3.7). Returns a copy. */
export function scrubJson(value, depth = 0) {
  if (depth > 40) return null;
  if (typeof value === 'string') return scrubText(value).text;
  if (Array.isArray(value)) return value.map((v) => scrubJson(v, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubJson(v, depth + 1)]));
  return value;
}

const plainObject = (v, field) => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) throw new ValidationError(`${field} must be an object`);
  return scrubJson(v);
};

/**
 * Where a task runs: "engine9/acme" (platform/account), or { platform, account_id, base_url?, connection? }.
 * `connection` names an entry in folio.json `connections` (its alias). No credentials, ever.
 */
export function parseEnvironment(input) {
  if (input === undefined || input === null || input === '') throw new ValidationError('A task needs an environment: where it runs, e.g. "engine9/acme" (platform/account)');
  let env;
  if (typeof input === 'string') {
    const m = /^([a-z][a-z0-9_-]*)\/(.+)$/i.exec(input.trim());
    if (!m) throw new ValidationError(`“${input}” is not an environment; write platform/account, e.g. engine9/acme`);
    env = { platform: m[1].toLowerCase(), account_id: m[2].trim() };
  } else if (typeof input === 'object' && !Array.isArray(input)) {
    env = {};
    if (input.platform !== undefined) env.platform = String(input.platform).trim().toLowerCase();
    if (input.account_id !== undefined && input.account_id !== null) env.account_id = String(input.account_id).trim();
    for (const k of ['base_url', 'connection', 'name']) if (str(input[k])) env[k] = str(input[k]);
  } else throw new ValidationError('environment must be "platform/account" or { platform, account_id }');
  if (!env.platform || !PLATFORM.test(env.platform)) throw new ValidationError('environment.platform is a lowercase word, e.g. engine9');
  if (!env.account_id) throw new ValidationError('environment.account_id says which account the task runs in');
  if (env.account_id.length > 200) throw new ValidationError('environment.account_id is too long');
  if (env.base_url) {
    let u;
    try {
      u = new URL(env.base_url);
    } catch {
      throw new ValidationError('environment.base_url must be a URL');
    }
    if (!/^https?:$/.test(u.protocol)) throw new ValidationError('environment.base_url must be http(s)');
    if (u.username || u.password) throw new ValidationError('environment.base_url must not carry credentials');
  }
  return env;
}

/** "engine9/acme". */
export const environmentLabel = (env) => (env ? `${env.platform}/${env.account_id}` : '');

/** "@engine9/plugins/e9workers:EchoWorker · echo" or "flow nightly-sync". */
export function taskTarget(t) {
  if (!t) return '';
  if (t.kind === 'flow' || (t.flow_id && !t.path)) return `flow ${t.flow_id}`;
  return [t.path, t.method].filter(Boolean).join(' · ');
}

function normalizeState(input, { required = false } = {}) {
  if (input === undefined || input === null || input === '') {
    if (required) throw new ValidationError('Give a state');
    return undefined;
  }
  const type = String(typeof input === 'object' ? input.type : input).trim().toUpperCase();
  if (!TASK_STATES.includes(type)) throw new ValidationError(`“${typeof input === 'object' ? input.type : input}” is not a task state (${TASK_STATES.join(', ')})`);
  const name = typeof input === 'object' ? str(input.name, 60) : undefined;
  return { type, ...(name ? { name } : {}) };
}

function normalizeRun(input, current = {}) {
  if (input === undefined || input === null) return Object.keys(current).length ? current : undefined;
  if (typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('run must be { flow_run_id?, task_run_ids?, url?, log_link? }');
  const run = { ...current };
  if (input.flow_run_id !== undefined) run.flow_run_id = str(String(input.flow_run_id ?? ''), 200);
  if (input.task_run_id !== undefined || input.task_run_ids !== undefined) {
    const ids = [].concat(input.task_run_ids ?? [], input.task_run_id ?? []).map((x) => String(x).trim()).filter(Boolean);
    run.task_run_ids = [...new Set([...(current.task_run_ids || []), ...ids])].slice(0, 200);
  }
  for (const k of ['url', 'log_link']) if (input[k] !== undefined) run[k] = str(String(input[k] ?? ''), 1000);
  for (const k of Object.keys(run)) if (run[k] === undefined || (Array.isArray(run[k]) && !run[k].length)) delete run[k];
  return Object.keys(run).length ? run : undefined;
}

function normalizeErrors(input) {
  if (input === undefined || input === null) return undefined;
  const list = Array.isArray(input) ? input : [input];
  const out = list
    .map((e) => (typeof e === 'string' ? { level: 'error', message: e } : e && typeof e === 'object' ? { level: str(e.level, 20) || 'error', message: String(e.message ?? '').slice(0, 2000), ...(e.ts ? { ts: String(e.ts) } : {}) } : null))
    .filter((e) => e && e.message.trim())
    .map((e) => ({ ...e, message: scrubText(e.message).text }));
  return out.slice(-MAX_ERRORS);
}

function normalizeSteps(input) {
  if (input === undefined || input === null) return undefined;
  if (!Array.isArray(input)) throw new ValidationError('tasks lists per-step overrides: [{ task_key, options }]');
  return input.map((s, i) => {
    if (!s || typeof s !== 'object' || !str(s.task_key)) throw new ValidationError(`tasks[${i}] needs a task_key`);
    return { task_key: str(s.task_key, 200), ...(s.options ? { options: plainObject(s.options, `tasks[${i}].options`) } : {}) };
  });
}

/**
 * Output for output.json: the worker's JSON result, scrubbed, at most MAX_TASK_OUTPUT as text. Bigger results
 * stay on the platform: keep a sample (or summarise it in `result`) and the run ids to fetch the rest.
 */
export function taskOutputText(output) {
  const text = JSON.stringify(scrubJson(output), null, 2) + '\n';
  if (text.length > MAX_TASK_OUTPUT)
    throw new ValidationError(`That output is ${Math.round(text.length / 1024)} KB; a folio keeps at most ${MAX_TASK_OUTPUT / 1024} KB. Keep a sample or a summary (result) and leave the full output on the platform (its run ids find it).`);
  return text;
}

/**
 * A new task record from what someone asked for. Exactly one of `path` + `method` (on demand) or `flow_id` (a
 * predefined flow). `within_minutes` sets `complete_by` from now. Throws ValidationError.
 */
export function createTaskRecord(input = {}, { now = new Date().toISOString(), id, actor } = {}) {
  const environment = parseEnvironment(input.environment);
  const path = str(input.path, 300);
  const method = str(input.method, 200);
  const flow_id = str(input.flow_id, 200);
  if (flow_id && (path || method)) throw new ValidationError('A task is either a flow (flow_id) or one method (path + method), not both');
  if (!flow_id && !(path && method)) throw new ValidationError('A task needs path and method (one worker method), or flow_id (a predefined flow)');
  const kind = flow_id ? 'flow' : 'on_demand';
  const title = cleanText(input.title, 300) || (flow_id ? `Run ${flow_id}` : `${method} (${path.split(/[:/]/).pop()})`);
  const created = iso(input.created_at, 'created_at') || now;
  let complete_by = iso(input.complete_by, 'complete_by');
  if (!complete_by && input.within_minutes !== undefined && input.within_minutes !== null && input.within_minutes !== '') {
    const n = Number(input.within_minutes);
    if (!Number.isFinite(n) || n <= 0 || n > 60 * 24 * 90) throw new ValidationError('within_minutes is a number of minutes, up to 90 days');
    complete_by = new Date(Date.parse(created) + n * 60_000).toISOString();
  }
  const state = normalizeState(input.state) || { type: 'PENDING' };
  const record = {
    format: TASK_FORMAT,
    format_revision: TASK_FORMAT_REVISION,
    id: id || (isTaskId(input.id) ? input.id : newTaskId()),
    title,
    ...(cleanText(input.summary, 1000) ? { summary: cleanText(input.summary, 1000) } : {}),
    ...(cleanText(input.description, 20000) ? { description: cleanText(input.description, 20000) } : {}),
    environment,
    kind,
    ...(kind === 'flow' ? { flow_id } : { path, method }),
    ...(kind === 'flow' && normalizeSteps(input.tasks)?.length ? { tasks: normalizeSteps(input.tasks) } : {}),
    ...(plainObject(input.options, 'options') ? { options: plainObject(input.options, 'options') } : {}),
    ...(str(input.tracking_code, 200) ? { tracking_code: str(input.tracking_code, 200) } : {}),
    ...(iso(input.start_after, 'start_after') ? { start_after: iso(input.start_after, 'start_after') } : {}),
    ...(complete_by ? { complete_by } : {}),
    ...(str(input.definition_url, 1000) ? { definition_url: str(input.definition_url, 1000) } : {}),
    ...(normalizeRun(input.run) ? { run: normalizeRun(input.run) } : {}),
    state,
    ...(iso(input.start_time, 'start_time') ? { start_time: iso(input.start_time, 'start_time') } : {}),
    ...(iso(input.end_time, 'end_time') ? { end_time: iso(input.end_time, 'end_time') } : {}),
    created_at: created,
    updated_at: now,
    ...(actor ? { created_by: actor } : {}),
    history: [{ at: now, state: state.type, ...(actor ? { actor } : {}), note: 'recorded' }],
  };
  return record;
}

/** Fields updateTask() changes, as the platform reports them. */
export const TASK_UPDATABLE = Object.freeze(['state', 'run', 'start_time', 'end_time', 'records', 'errors', 'result', 'output', 'summary', 'complete_by', 'options', 'note']);

/**
 * Apply a change to a task record (returns { next, changed: [fields], stateChanged }). `options` may change only
 * before the task starts (PENDING or PAUSED), as on engine9 (PATCH /task_runs/:id). The definition otherwise
 * stays as recorded: a different task is a new task.
 */
export function applyTaskUpdate(current, patch = {}, { now = new Date().toISOString(), actor, via } = {}) {
  for (const k of Object.keys(patch)) if (!TASK_UPDATABLE.includes(k) && patch[k] !== undefined) throw new ValidationError(`${k} cannot be changed on a task (changeable: ${TASK_UPDATABLE.join(', ')}). A different definition is a new task.`);
  const next = { ...current };
  const changed = [];
  const set = (k, v) => {
    if (JSON.stringify(next[k]) === JSON.stringify(v)) return;
    if (v === undefined) delete next[k];
    else next[k] = v;
    changed.push(k);
  };
  const state = normalizeState(patch.state);
  const before = current.state?.type;
  if (state) set('state', state);
  if (patch.run !== undefined) set('run', normalizeRun(patch.run, current.run || {}));
  for (const k of ['start_time', 'end_time', 'complete_by']) if (patch[k] !== undefined) set(k, iso(patch[k], k));
  if (patch.records !== undefined) {
    const n = patch.records === null ? undefined : Number(patch.records);
    if (n !== undefined && (!Number.isFinite(n) || n < 0)) throw new ValidationError('records is a count');
    set('records', n);
  }
  if (patch.errors !== undefined) set('errors', normalizeErrors(patch.errors)?.length ? normalizeErrors(patch.errors) : undefined);
  if (patch.result !== undefined) set('result', cleanText(patch.result, 8000));
  if (patch.summary !== undefined) set('summary', cleanText(patch.summary, 1000));
  if (patch.options !== undefined) {
    if (!['PENDING', 'PAUSED'].includes(before)) throw new ValidationError('Options can change only before the task starts (PENDING or PAUSED)');
    set('options', plainObject(patch.options, 'options'));
  }
  // The state each change landed in; the end time when it finished (if the platform did not say).
  if (state && isTerminalState(state) && !next.end_time) set('end_time', now);
  if (state && state.type === 'RUNNING' && !next.start_time) set('start_time', now);
  const stateChanged = Boolean(state) && state.type !== before;
  const note = cleanText(patch.note, 500);
  if (!changed.length && !note) return { next: current, changed, stateChanged: false };
  next.updated_at = now;
  if (stateChanged || note) {
    const entry = { at: now, state: next.state?.type, ...(actor ? { actor } : {}), ...(via ? { via } : {}), ...(note ? { note } : {}) };
    next.history = [...(current.history || []), entry].slice(-MAX_TASK_HISTORY);
  }
  return { next, changed, stateChanged };
}

/** Is this task past its window: not finished, and complete_by has passed? */
export const isOverdue = (t, now = new Date().toISOString()) => Boolean(t?.complete_by) && !isTerminalState(t.state) && Date.parse(now) > Date.parse(t.complete_by);

/** What a list of tasks shows for one: no description, options or history. */
export function taskSummary(t, dir, now) {
  return {
    id: t.id,
    dir,
    path: `${TASKS_DIR}/${dir}`,
    title: t.title,
    ...(t.summary ? { summary: t.summary } : {}),
    environment: t.environment,
    kind: t.kind,
    target: taskTarget(t),
    ...(t.kind === 'flow' ? { flow_id: t.flow_id } : { path_name: t.path, method: t.method }),
    state: t.state?.type || 'PENDING',
    ...(t.state?.name ? { state_name: t.state.name } : {}),
    done: isTerminalState(t.state),
    overdue: isOverdue(t, now),
    ...(t.run ? { run: t.run } : {}),
    ...(t.complete_by ? { complete_by: t.complete_by } : {}),
    ...(t.records !== undefined ? { records: t.records } : {}),
    ...(t.errors?.length ? { error: t.errors.at(-1).message } : {}),
    ...(t.result ? { result: t.result.slice(0, 500) } : {}),
    ...(t.output ? { has_output: true } : {}),
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}

/** A folder name for a new task in tasks/, from its title. */
export const taskDirName = (title) => slugify(String(title || ''), 50) || 'task';

/** Problems with a task.json (for validate): [{ level, code, message }]. */
export function validateTaskRecord(t) {
  const out = [];
  const add = (level, code, message) => out.push({ level, code, message });
  if (!t || typeof t !== 'object') return [{ level: 'error', code: 'task_shape', message: 'task.json must be an object' }];
  if (!isTaskId(t.id)) add('error', 'task_id', 'A task needs an id like tsk-xxxxxx');
  if (!t.title) add('error', 'task_title', 'A task needs a title');
  try {
    parseEnvironment(t.environment);
  } catch (e) {
    add('error', 'task_environment', e.message);
  }
  if (t.flow_id ? t.path || t.method : !(t.path && t.method)) add('error', 'task_definition', 'A task is either path + method or flow_id');
  if (t.state && !TASK_STATES.includes(t.state.type)) add('warning', 'task_state', `Unknown task state ${t.state.type}`);
  for (const k of ['created_at', 'complete_by', 'start_after', 'start_time', 'end_time']) if (t[k] && Number.isNaN(Date.parse(t[k]))) add('warning', 'task_date', `${k} is not a date`);
  return out;
}
