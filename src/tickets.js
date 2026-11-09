export const TICKET_TYPES = ['support', 'bug', 'request', 'feature', 'review', 'investigation', 'epic'];
export const TICKET_STATUSES = ['open', 'in_progress', 'blocked', 'resolved', 'closed', 'cancelled'];
export const TICKET_PRIORITIES = ['urgent', 'high', 'normal', 'low'];
export const RESOLVED_STATUSES = ['resolved', 'closed', 'cancelled'];
export const RELATIONSHIP_TYPES = ['parent', 'blocked_by', 'related', 'discovered_from', 'duplicate_of', 'supersedes'];

const TICKET_ID = /^TK-\d{3,}$/;
export const isTicketId = (s) => typeof s === 'string' && TICKET_ID.test(s);

export function validateTicket(t, path = 'ticket.json') {
  const problems = [];
  const err = (code, message) => problems.push({ level: 'error', code, path, message });
  if (!t || typeof t !== 'object') return [{ level: 'error', code: 'ticket_not_object', path, message: 'ticket must be an object' }];
  if (!isTicketId(t.id)) err('ticket_id', 'id must look like TK-001');
  if (typeof t.title !== 'string' || !t.title.trim()) err('ticket_title', 'title is required');
  if (!TICKET_TYPES.includes(t.type)) err('ticket_type', `type must be one of ${TICKET_TYPES.join(', ')}`);
  if (!TICKET_STATUSES.includes(t.status)) err('ticket_status', `status must be one of ${TICKET_STATUSES.join(', ')}`);
  if (!TICKET_PRIORITIES.includes(t.priority)) err('ticket_priority', `priority must be one of ${TICKET_PRIORITIES.join(', ')}`);
  if (!Number.isInteger(t.revision) || t.revision < 1) err('ticket_revision', 'revision must be a positive integer');
  if (t.status === 'closed' && !t.resolution) err('ticket_resolution', 'a closed ticket needs a resolution');
  for (const k of ['created_at', 'updated_at']) if (Number.isNaN(Date.parse(t[k]))) err('ticket_date', `${k} must be an ISO timestamp`);
  for (const k of ['tags', 'labels']) {
    if (t[k] !== undefined && (!Array.isArray(t[k]) || t[k].some((x) => typeof x !== 'string'))) err('ticket_tags', `${k} must be an array of strings`);
  }
  if (t.external !== undefined && (!t.external || typeof t.external !== 'object' || typeof t.external.source !== 'string' || typeof t.external.id !== 'string'))
    err('ticket_external', 'external must be { source, id } naming where the ticket was imported from');
  if (t.relationships !== undefined) {
    if (!Array.isArray(t.relationships)) err('ticket_relationships', 'relationships must be an array');
    else
      t.relationships.forEach((r) => {
        if (!r || !RELATIONSHIP_TYPES.includes(r.type) || !isTicketId(r.target)) err('ticket_relationship', `invalid relationship ${JSON.stringify(r)}`);
        else if (r.target === t.id) err('ticket_self_reference', `${t.id} cannot relate to itself`);
      });
  }
  return problems;
}

/**
 * Builds both directions of every relationship from the stored (one-directional)
 * records, so the inverse can never drift out of sync with the files.
 */
export function buildGraph(tickets) {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const g = { byId, children: new Map(), blocks: new Map(), blockedBy: new Map(), related: new Map(), derived: new Map(), duplicates: new Map(), supersededBy: new Map(), parent: new Map() };
  const push = (map, k, v) => map.set(k, [...(map.get(k) || []), v]);
  for (const t of tickets) {
    for (const r of t.relationships || []) {
      if (!byId.has(r.target)) continue;
      if (r.type === 'parent') { g.parent.set(t.id, r.target); push(g.children, r.target, t.id); }
      else if (r.type === 'blocked_by') { push(g.blockedBy, t.id, r.target); push(g.blocks, r.target, t.id); }
      else if (r.type === 'related') { push(g.related, t.id, r.target); push(g.related, r.target, t.id); }
      else if (r.type === 'discovered_from') push(g.derived, r.target, t.id);
      else if (r.type === 'duplicate_of') push(g.duplicates, r.target, t.id);
      else if (r.type === 'supersedes') push(g.supersededBy, r.target, t.id);
    }
  }
  return g;
}

/** Returns a cycle path (array of ids) in the given relationship type, or null. */
export function findCycle(tickets, type) {
  const next = new Map(tickets.map((t) => [t.id, (t.relationships || []).filter((r) => r.type === type).map((r) => r.target)]));
  const state = new Map();
  const stack = [];
  const visit = (id) => {
    state.set(id, 1);
    stack.push(id);
    for (const n of next.get(id) || []) {
      if (!next.has(n)) continue;
      if (state.get(n) === 1) return [...stack.slice(stack.indexOf(n)), n];
      if (!state.get(n)) {
        const c = visit(n);
        if (c) return c;
      }
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const id of next.keys()) if (!state.get(id)) { const c = visit(id); if (c) return c; }
  return null;
}

/** Would adding `from --type--> to` create a cycle (or a self reference)? */
export function wouldCycle(tickets, from, type, to) {
  if (from === to) return [from, to];
  if (type !== 'parent' && type !== 'blocked_by') return null;
  const trial = tickets.map((t) => (t.id === from ? { ...t, relationships: [...(t.relationships || []), { type, target: to }] } : t));
  return findCycle(trial, type);
}

/**
 * Readiness in ordinary language. Calculated from ticket files only; there is
 * no separate status table. `state` is one of:
 *   ready, in_progress, waiting, blocked, done
 */
export function readiness(ticket, graph) {
  const reasons = [];
  if (RESOLVED_STATUSES.includes(ticket.status)) return { ready: false, state: 'done', reasons: [`This ticket is ${ticket.status}.`] };
  const openBlockers = (graph.blockedBy.get(ticket.id) || []).filter((id) => {
    const b = graph.byId.get(id);
    return b && !RESOLVED_STATUSES.includes(b.status);
  });
  if (ticket.hold) reasons.push(`On hold${ticket.hold.reason ? `: ${ticket.hold.reason}` : ''}.`);
  if (ticket.status === 'blocked' && !ticket.hold && openBlockers.length === 0) reasons.push('Marked blocked, but no reason is recorded.');
  if (openBlockers.length) reasons.push(`Waiting for ${openBlockers.join(', ')} to be resolved.`);
  if (reasons.length) return { ready: false, state: 'blocked', reasons, blocked_by: openBlockers, held: Boolean(ticket.hold) };
  if (ticket.waiting_on) return { ready: false, state: 'waiting', reasons: [`Waiting on ${ticket.waiting_on}.`] };
  if (ticket.status === 'in_progress') return { ready: false, state: 'in_progress', reasons: ['Already in progress.'] };
  return { ready: true, state: 'ready', reasons: ['Open, not on hold, and nothing unresolved blocks it.'] };
}
