#!/usr/bin/env node
import { Folio } from '../src/folio.js';
import { LocalHold, NodeFs } from '../src/node-fs.js';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';

const USAGE = `folio: work with folio folders

  Everything is a folio: a folder with a folio.json. A request, a bug or a sub-project is a folio inside a folio (a sub-folio).

  folio init <dir> --title "Title" [--summary "..."] [--type project] [--status active]
  folio new <dir> --title "..." [--type request] [--status backlog] [--tags "a, b"] [--owner ...] [--description "..."]
      creates a folio inside <dir> (in its own folder, named after the title)
  folio list <dir>                                     the folios inside, with status and readiness
  folio set <dir> --status active [--owner ...] [--tags "a, b"] [--type ...] [--title ...] [--target-date YYYY-MM-DD]
  folio relate <dir> <blocked_by|related|discovered_from|duplicate_of|supersedes> <fol-id>
  folio history <dir>
  folio validate <dir>
  folio overview <dir>
  folio ready <dir>                                    folios inside that could be started now
  folio add <dir> <file | folder | url | "text"> ... [--folder notes] [--as markdown|html|text|json|import|comment|update|file]
      files the item where it belongs: repo URL -> repositories, .eml -> comms,
      other links -> sources/links, text -> notes, files -> attachments,
      data files and logs -> a summary in sources/data, the file itself held in ~/.folio/hold
      (or FOLIO_HOLD_DIR, or --hold-dir) for 30 days. See GUIDE.md for what folios must not hold.
      Text is saved as .md, .html or .txt by what it looks like; --as picks the type instead.
      An Asana or Trello JSON export (or { "folios": [...] }) becomes folios inside this one.
  folio import <dir> <export.json> [--format asana|trello|folio-list] [--dry-run]
  folio retype <dir> <path> <markdown|html|text>     change a note's file type
  folio comment <dir> "text" [--kind comment|update|agent]
  folio comms <dir>                                    the conversation in time order
  folio repo add <dir> <owner/name | url> [--purpose "..."] [--role primary]
  folio repo list <dir>
  folio search <dir> <text>
  folio checklist <dir> [--add "text"] [--check N] [--uncheck N] [--remove N]   the README's checklist (SPEC 5.9)
  folio task list <dir>                                the folio's tasks: well-defined work run elsewhere (SPEC 5.8)
  folio task add <dir> --env engine9/acme (--path <plugin path> --method <m> | --flow <flow_id>) [--title ...]
      [--options '{"k":"v"}'] [--within <minutes>] [--flow-run <id>] [--task-run <id>] [--state PENDING]
  folio task set <dir> <tsk-id | folder> [--state COMPLETED] [--records N] [--result "..."] [--error "..."]
      [--output output.json] [--flow-run <id>] [--task-run <id>] [--note "..."]
`;

function parse(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      flags[k] = v;
    } else pos.push(a);
  }
  return { pos, flags };
}

const out = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));

async function main() {
  const { pos, flags } = parse(process.argv.slice(2));
  const [cmd, ...rest] = pos;
  const actor = { type: 'user', id: process.env.USER || 'cli' };
  const via = 'folio-cli';
  if (!cmd || cmd === 'help' || flags.help) return out(USAGE);

  if (cmd === 'init') {
    const [dir] = rest;
    if (!dir || !flags.title) throw new Error('usage: folio init <dir> --title "Title"');
    await mkdir(dir, { recursive: true });
    const f = await Folio.init(new NodeFs(dir), { title: String(flags.title), summary: flags.summary && String(flags.summary), type: flags.type && String(flags.type), status: flags.status ? String(flags.status) : 'active', actor, via });
    return out(`Created folio ${(await f.manifest()).manifest.id} in ${dir}`);
  }

  // `repo` takes a subcommand first: folio repo list <dir>. Others: folio validate <dir>.
  const grouped = cmd === 'repo' || cmd === 'task';
  const sub0 = grouped ? rest[0] : undefined;
  const [dir, ...tail] = grouped ? rest.slice(1) : rest;
  const args = grouped ? [sub0, ...tail] : tail;
  if (!dir) throw new Error(`usage: folio ${cmd}${grouped ? ' <subcommand>' : ''} <dir> ...`);
  const folio = await Folio.open(new NodeFs(dir), { nested: 'detect' });

  if (cmd === 'validate') {
    const { ok, problems } = await folio.validate();
    for (const p of problems) console.log(`${p.level.toUpperCase().padEnd(7)} ${p.path}  ${p.message}`);
    console.log(ok ? `OK${problems.length ? ` (${problems.length} warning${problems.length === 1 ? '' : 's'})` : ''}` : 'INVALID');
    process.exitCode = ok ? 0 : 1;
    return;
  }
  if (cmd === 'overview') return out(await folio.overview());
  if (cmd === 'ready') {
    for (const c of (await folio.children()).filter((c) => c.readiness.ready)) console.log(`${c.id}  ${c.title}  (${c.dir})`);
    return;
  }
  if (cmd === 'search') return out(await folio.search(args.join(' ')));

  if (cmd === 'add') {
    if (!args.length) throw new Error('usage: folio add <dir> <file | folder | url | "text"> ...');
    const as = flags.as ? String(flags.as) : undefined;
    const opts = { actor, via, ...(flags.folder ? { folder: String(flags.folder) } : {}) };
    const hold = new LocalHold({ dir: flags['hold-dir'] && String(flags['hold-dir']), folioId: (await folio.manifest()).manifest.id });
    await hold.sweep();
    folio.hold = hold;
    const items = [];
    const walk = async (abs, root) => {
      const st = await stat(abs);
      if (st.isDirectory() && /^(\.git|node_modules|\.venv|venv|__pycache__)$/.test(basename(abs))) {
        console.log(`${'skipped'.padEnd(10)} ${relative(root || '.', abs)}: code and tooling folders belong in a repository`);
        return;
      }
      if (st.isDirectory()) for (const e of await readdir(abs)) await walk(join(abs, e), root);
      else items.push({ name: basename(abs), path: root ? relative(root, abs) : undefined, data: new Uint8Array(await readFile(abs)), as });
    };
    for (const a of args) {
      const st = await stat(a).catch(() => null);
      if (!st) items.push({ text: a, as });
      else await walk(a, st.isDirectory() ? join(a, '..') : null);
    }
    for (const item of items) for (const r of await folio.add(item, opts)) console.log(`${r.kind.padEnd(10)} ${r.summary}`);
    return;
  }

  if (cmd === 'import') {
    if (!args[0]) throw new Error('usage: folio import <dir> <export.json>');
    const r = await folio.import(new Uint8Array(await readFile(args[0])), { format: flags.format && String(flags.format), name: basename(args[0]), actor, via, dryRun: Boolean(flags['dry-run']) });
    return out(flags['dry-run'] ? r : r.summary);
  }
  if (cmd === 'retype') {
    if (!args[1]) throw new Error('usage: folio retype <dir> <path> <markdown|html|text>');
    return out((await folio.setTextFormat(args[0], args[1], { actor, via })).summary);
  }

  if (cmd === 'comment') return out((await folio.comment(args.join(' '), { actor, via, kind: flags.kind ? String(flags.kind) : 'comment' })).path);
  if (cmd === 'comms') {
    for (const m of await folio.comms()) console.log(`${String(m.at).slice(0, 16)}  ${m.kind.padEnd(7)} ${m.subject ? `${m.subject}: ` : ''}${m.text.split('\n')[0].slice(0, 100)}`);
    return;
  }

  if (cmd === 'repo') {
    const [sub, ...a] = args;
    if (sub === 'list') {
      for (const r of await folio.repositories()) console.log(`${r.provider}  ${r.repository || r.url}  ${r.role || ''}  ${r.purpose || ''}  [${r.integration_state}]`);
      return;
    }
    if (sub === 'add') {
      const added = await folio.addRepository({ ...(a[0].includes('://') ? { url: a[0] } : { repository: a[0] }), ...(flags.purpose ? { purpose: String(flags.purpose) } : {}), ...(flags.role ? { role: String(flags.role) } : {}) }, { actor });
      return out(added);
    }
  }

  if (cmd === 'checklist') {
    const changes = {};
    for (const k of ['add', 'check', 'uncheck', 'remove']) if (flags[k] !== undefined) changes[k] = [String(flags[k])];
    const c = Object.keys(changes).length ? await folio.editChecklist(changes) : await folio.checklist();
    for (const i of c.items) console.log(`${String(i.n).padStart(2)}. [${i.done ? 'x' : ' '}] ${i.text}`);
    return out(c.total ? `${c.done}/${c.total} done` : 'No checklist yet. Add one with --add "text".');
  }
  if (cmd === 'task') {
    const [sub, ...a] = args;
    const json = (v, what) => {
      try {
        return JSON.parse(String(v));
      } catch {
        throw new Error(`${what} must be JSON`);
      }
    };
    const run = flags['flow-run'] || flags['task-run'] ? { ...(flags['flow-run'] ? { flow_run_id: String(flags['flow-run']) } : {}), ...(flags['task-run'] ? { task_run_ids: [String(flags['task-run'])] } : {}) } : undefined;
    if (sub === 'list') {
      for (const t of await folio.tasks()) console.log(`${t.id}  ${t.state.padEnd(9)} ${t.overdue ? 'OVERDUE ' : ''}${t.title}  ${t.environment.platform}/${t.environment.account_id}  ${t.target}  (${t.path})`);
      return;
    }
    if (sub === 'add') {
      const r = await folio.addTask({ environment: flags.env && String(flags.env), title: flags.title && String(flags.title), path: flags.path && String(flags.path), method: flags.method && String(flags.method), flow_id: flags.flow && String(flags.flow), options: flags.options ? json(flags.options, '--options') : undefined, within_minutes: flags.within, state: flags.state && String(flags.state), run }, { actor, via });
      return out(`Recorded ${r.id} in ${r.path}`);
    }
    if (sub === 'set') {
      if (!a[0]) throw new Error('usage: folio task set <dir> <tsk-id | folder> --state ...');
      const patch = { run };
      for (const k of ['state', 'result', 'note']) if (flags[k] !== undefined) patch[k] = String(flags[k]);
      if (flags.records !== undefined) patch.records = Number(flags.records);
      if (flags.error !== undefined) patch.errors = [String(flags.error)];
      if (flags.output !== undefined) patch.output = json(await readFile(String(flags.output), 'utf8'), '--output');
      const r = await folio.updateTask(a[0], patch, { actor, via });
      return out(`${r.task.title}: ${r.task.state.type}${r.changed.length ? ` (changed ${r.changed.join(', ')})` : ' (no change)'}`);
    }
    throw new Error('usage: folio task <list|add|set> <dir> ...');
  }

  if (cmd === 'new') {
    if (!flags.title) throw new Error('--title is required');
    const r = await folio.createChild({ title: String(flags.title), ...(flags.type ? { type: String(flags.type) } : {}), status: flags.status ? String(flags.status) : 'backlog', tags: flags.tags && String(flags.tags), owner: flags.owner && String(flags.owner), description: flags.description && String(flags.description) }, { actor, via });
    return out(`Created ${r.id} in ${join(dir, r.dir)}`);
  }
  if (cmd === 'list') {
    for (const c of await folio.children()) console.log(`${c.id}  ${String(c.status).padEnd(10)} ${c.readiness.state.padEnd(11)} ${c.title}  (${c.dir})`);
    return;
  }
  if (cmd === 'set') {
    const patch = {};
    for (const k of ['status', 'owner', 'type', 'title', 'resolution', 'tags', 'summary', 'outcome']) if (flags[k] !== undefined) patch[k] = String(flags[k]);
    if (flags['target-date'] !== undefined) patch.target_date = String(flags['target-date']);
    const m = await folio.edit(patch, { actor, via });
    return out(`${m.title}: ${m.status}`);
  }
  if (cmd === 'relate') return out((await folio.relate(args[0], args[1], { actor, via })).relationships);
  if (cmd === 'history') {
    for (const h of await folio.history()) console.log(`${String(h.at).slice(0, 16)}  ${h.type.padEnd(8)} ${Object.entries(h.changes || {}).map(([k, v]) => `${k}: ${JSON.stringify(v.from)} → ${JSON.stringify(v.to)}`).join('; ')}`);
    return;
  }
  throw new Error(`Unknown command. Run "folio help".`);
}

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
