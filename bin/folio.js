#!/usr/bin/env node
import { Folio } from '../src/folio.js';
import { NodeFs } from '../src/node-fs.js';
import { mkdir } from 'node:fs/promises';

const USAGE = `folio: work with folio folders

  folio init <dir> --title "Title" [--summary "..."]
  folio validate <dir>
  folio overview <dir>
  folio ready <dir>
  folio ticket new <dir> --title "..." [--type bug] [--priority high] [--description "..."]
  folio ticket list <dir>
  folio ticket show <dir> <TK-001>
  folio ticket set <dir> <TK-001> --status in_progress [--priority ...] [--owner ...]
  folio ticket relate <dir> <TK-001> <parent|blocked_by|related|discovered_from|duplicate_of|supersedes> <TK-002>
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
    const f = await Folio.init(new NodeFs(dir), { title: String(flags.title), summary: flags.summary && String(flags.summary) });
    return out(`Created folio ${(await f.manifest()).manifest.id} in ${dir}`);
  }

  // `ticket` and `repo` take a subcommand first: folio ticket list <dir>. Others: folio validate <dir>.
  const grouped = cmd === 'ticket' || cmd === 'repo';
  const sub0 = grouped ? rest[0] : undefined;
  const [dir, ...tail] = grouped ? rest.slice(1) : rest;
  const args = grouped ? [sub0, ...tail] : tail;
  if (!dir) throw new Error(`usage: folio ${cmd}${grouped ? ' <subcommand>' : ''} <dir> ...`);
  const folio = await Folio.open(new NodeFs(dir));

  if (cmd === 'validate') {
    const { ok, problems } = await folio.validate();
    for (const p of problems) console.log(`${p.level.toUpperCase().padEnd(7)} ${p.path}  ${p.message}`);
    console.log(ok ? `OK${problems.length ? ` (${problems.length} warning${problems.length === 1 ? '' : 's'})` : ''}` : 'INVALID');
    process.exitCode = ok ? 0 : 1;
    return;
  }
  if (cmd === 'overview') return out(await folio.overview());
  if (cmd === 'ready') {
    for (const t of await folio.readyTickets()) console.log(`${t.id}  [${t.priority}]  ${t.title}`);
    return;
  }
  if (cmd === 'search') return out(await folio.search(args.join(' ')));

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

  if (cmd === 'ticket') {
    const [sub, ...a] = args;
    if (sub === 'new') {
      if (!flags.title) throw new Error('--title is required');
      return out(await folio.createTicket({ title: String(flags.title), type: flags.type && String(flags.type), priority: flags.priority && String(flags.priority), description: flags.description && String(flags.description) }, { actor, via }));
    }
    if (sub === 'list') {
      for (const t of await folio.ticketViews()) console.log(`${t.id}  ${t.status.padEnd(11)} ${t.readiness.state.padEnd(11)} [${t.priority}]  ${t.title}`);
      return;
    }
    if (sub === 'show') return out({ ...(await folio.ticketViews()).find((t) => t.id === a[0]), events: await folio.ticketEvents(a[0]) });
    if (sub === 'set') {
      const patch = {};
      for (const k of ['status', 'priority', 'owner', 'type', 'title', 'resolution', 'resolution_note']) if (flags[k] !== undefined) patch[k] = String(flags[k]);
      return out(await folio.updateTicket(a[0], patch, { actor, via }));
    }
    if (sub === 'relate') return out(await folio.relate(a[0], a[1], a[2], { actor, via }));
  }
  throw new Error(`Unknown command. Run "folio help".`);
}

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
