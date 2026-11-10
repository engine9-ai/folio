import { postMessage } from './comms.js';
import { isEmailPath } from './comms.js';
import { newFolioId } from './manifest.js';
import { RELATIONSHIP_TYPES, normalizeTags } from './relations.js';

/**
 * Folios written before version 1 kept work items as tickets: tickets/TK-001/{ticket.json, description.md,
 * events/, attachments/}. A ticket is now simply a folio inside its folio. This turns each ticket into one,
 * keeping everything it had:
 *
 *   title, type, tags, owner, target date, outcome, resolution  -> folio.json
 *   status: open -> backlog, in_progress -> active, blocked -> waiting, resolved -> review,
 *           closed -> completed, cancelled -> archived (resolution "cancelled")
 *   description.md                -> README.md
 *   a parent ticket               -> the folder it sits in (subtasks inside their task)
 *   blocked_by, related ...       -> relationships to the new folio ids
 *   comments (ticket events, or messages in comms/ with "ticket")  -> the new folio's comms/
 *   other events                  -> its history/changes/
 *   attachments/ and linked files -> its attachments/ (emails it linked to: copied into its comms/)
 *   the ticket id (TK-001)        -> `aliases`, so addresses like folio+fol-x+TK-001@ and old references still work
 */

const STATUS = { open: 'backlog', in_progress: 'active', blocked: 'waiting', resolved: 'review', closed: 'completed', cancelled: 'archived' };
const json = (o) => JSON.stringify(o, null, 2) + '\n';

async function bytesOf(fs, path) {
  const cur = typeof fs.readBytes === 'function' ? await fs.readBytes(path) : await fs.read(path);
  return cur ? cur.bytes ?? cur.text : null;
}

export async function convertTickets(folio, { actor, via = 'folio-lib', moves = {} } = {}) {
  const fs = folio.fs;
  const files = await fs.list('tickets');
  const ids = [...new Set(files.map((f) => /^tickets\/(TK-\d+)\//.exec(f)?.[1]).filter(Boolean))].sort();
  if (!ids.length) return [];
  const tickets = [];
  for (const id of ids) {
    const cur = await fs.read(`tickets/${id}/ticket.json`);
    if (!cur) continue;
    try {
      tickets.push(JSON.parse(cur.text));
    } catch {
      /* left in place: validate() reports it */
    }
  }
  const newId = new Map(tickets.map((t) => [t.id, newFolioId()]));
  const parentOf = (t) => (t.relationships || []).find((r) => r.type === 'parent' && newId.has(r.target))?.target || null;
  // Messages posted to comms/ with a ticket (between versions 0.6 and 1) move with their ticket.
  const commsFiles = (await fs.list('comms')).filter((p) => /\.(comment|update|agent|chat)\.json$/.test(p));
  const ticketMessages = new Map();
  for (const p of commsFiles) {
    try {
      const m = JSON.parse((await fs.read(p)).text);
      if (m.ticket && newId.has(m.ticket)) ticketMessages.set(m.ticket, [...(ticketMessages.get(m.ticket) || []), { path: p, m }]);
    } catch {
      /* not a message */
    }
  }

  const placed = new Map(); // ticket id -> dir
  const out = [];
  let pending = [...tickets];
  while (pending.length) {
    const next = [];
    for (const t of pending) {
      const parent = parentOf(t);
      if (parent && !placed.has(parent)) {
        if (pending.some((x) => x.id === parent)) {
          next.push(t);
          continue;
        }
      }
      const links = [];
      const copies = [];
      for (const l of t.links || []) {
        if (l?.url) links.push({ type: l.type || 'url', ...(l.label ? { label: l.label } : {}), url: l.url });
        else if (l?.path) copies.push(moves[l.path] || l.path);
      }
      const rels = (t.relationships || []).filter((r) => r.type !== 'parent' && RELATIONSHIP_TYPES.concat(['duplicate_of']).includes(r.type) && newId.has(r.target)).map((r) => ({ type: r.type, target: newId.get(r.target) }));
      const description = (await fs.read(`tickets/${t.id}/description.md`))?.text;
      const status = STATUS[t.status] || 'backlog';
      const r = await folio.createChild(
        {
          id: newId.get(t.id),
          title: t.title || t.id,
          description,
          type: t.type || 'ticket',
          status,
          tags: normalizeTags(t.tags ?? t.labels),
          owner: t.owner || undefined,
          target_date: /^\d{4}-\d{2}-\d{2}$/.test(t.target_date || '') ? t.target_date : undefined,
          outcome: t.outcome || undefined,
          resolution: t.status === 'cancelled' ? t.resolution || 'cancelled' : t.resolution || undefined,
          waiting_on: t.waiting_on || undefined,
          hold: t.hold || undefined,
          links: links.length ? links : undefined,
          relationships: rels.length ? rels : undefined,
          external: t.external?.source && t.external?.id ? t.external : undefined,
          aliases: [t.id],
        },
        { actor, via, inDir: parent ? placed.get(parent) : '' }
      );
      placed.set(t.id, r.dir);
      const child = r.folio;
      // Files: the ticket's attachments, and files it linked to.
      for (const p of files.filter((f) => f.startsWith(`tickets/${t.id}/attachments/`))) {
        const data = await bytesOf(fs, p);
        if (data !== null) await child.fs.write(`attachments/${p.slice(`tickets/${t.id}/attachments/`.length)}`, data);
      }
      for (const p of copies) {
        const data = await bytesOf(fs, p);
        if (data === null) continue;
        const name = p.split('/').pop();
        await child.fs.write(isEmailPath(p) ? `comms/${name}` : `attachments/${name}`, data);
      }
      // History and comments.
      const evFiles = files.filter((f) => f.startsWith(`tickets/${t.id}/events/`) && f.endsWith('.json')).sort();
      for (const ef of evFiles) {
        let e;
        try {
          e = JSON.parse((await fs.read(ef)).text);
        } catch {
          continue;
        }
        if (e.type === 'comment' && e.comment) {
          await postMessage(child, { kind: 'comment', text: e.comment, actor: e.actor, via: e.via || via, at: e.imported?.at && !Number.isNaN(Date.parse(e.imported.at)) ? new Date(e.imported.at).toISOString() : e.at, ...(e.imported ? { imported: e.imported } : {}) });
          continue;
        }
        const stamp = String(e.at || '').replace(/[-:]/g, '').replace(/\.(\d+)Z$/, '$1Z') || String(e.revision);
        await child.fs.write(`history/changes/${stamp}-${String(e.revision).padStart(6, '0')}.json`, json({ at: e.at, actor: e.actor, via: e.via, type: e.type, ...(e.changes ? { changes: e.changes } : {}), ticket: { id: t.id, revision: e.revision } }));
      }
      for (const { path, m } of ticketMessages.get(t.id) || []) {
        const { ticket, ...rest } = m;
        await child.fs.write(`comms/${path.slice('comms/'.length)}`, json(rest));
        await fs.remove(path);
      }
      out.push({ id: r.id, dir: r.dir, alias: t.id });
    }
    if (next.length === pending.length) {
      // A parent loop: place the rest at the top.
      for (const t of next) (t.relationships || []).splice(0);
    }
    pending = next;
  }
  for (const f of files) await fs.remove(f);
  return out;
}
