#!/usr/bin/env node
import { Folio } from '../src/folio.js';
import { LocalHold, NodeFs } from '../src/node-fs.js';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';

const USAGE = `folio: work with folio folders

  Everything is a folio: a folder with a folio.json. A ticket, a task or a sub-project is a folio inside a folio.

  folio init <dir> --title "Title" [--summary "..."] [--type project] [--status active]
  folio new <dir> --title "..." [--type ticket] [--status backlog] [--priority high] [--tags "a, b"] [--owner ...] [--description "..."]
      creates a folio inside <dir> (in its own folder, named after the title)
  folio list <dir>                                     the folios inside, with status, readiness and priority
  folio set <dir> --status active [--priority ...] [--owner ...] [--tags "a, b"] [--type ...] [--title ...] [--target-date YYYY-MM-DD]
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
      An Asana or Trello JSON export (or { "tickets": [...] }) becomes folios inside this one.
  folio import <dir> <export.json> [--format asana|trello|folio-list] [--dry-run]
  folio retype <dir> <path> <markdown|html|text>     change a note's file type
  folio comment <dir> "text" [--kind comment|update|agent]
  folio comms <dir>                                    the conversation in time order
  folio upgrade <dir>                                  bring an older folio up to date (comms/, attachments/, tickets -> folios)
  folio repo add <dir> <owner/name | url> [--purpose "..."] [--role primary]
  folio repo list <dir>
  folio search <dir> <text>
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
  const grouped = cmd === 'repo';
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
    for (const c of (await folio.children()).filter((c) => c.readiness.ready)) console.log(`${c.id}  [${c.priority || 'normal'}]  ${c.title}  (${c.dir})`);
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
  if (cmd === 'upgrade') return out((await folio.upgradeLayout({ actor, via })).summary);

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

  if (cmd === 'new') {
    if (!flags.title) throw new Error('--title is required');
    const r = await folio.createChild({ title: String(flags.title), type: flags.type ? String(flags.type) : 'ticket', status: flags.status ? String(flags.status) : 'backlog', priority: flags.priority && String(flags.priority), tags: flags.tags && String(flags.tags), owner: flags.owner && String(flags.owner), description: flags.description && String(flags.description) }, { actor, via });
    return out(`Created ${r.id} in ${join(dir, r.dir)}`);
  }
  if (cmd === 'list') {
    for (const c of await folio.children()) console.log(`${c.id}  ${String(c.status).padEnd(10)} ${c.readiness.state.padEnd(11)} [${c.priority || 'normal'}]  ${c.title}  (${c.dir})`);
    return;
  }
  if (cmd === 'set') {
    const patch = {};
    for (const k of ['status', 'priority', 'owner', 'type', 'title', 'resolution', 'tags', 'summary', 'outcome']) if (flags[k] !== undefined) patch[k] = String(flags[k]);
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
