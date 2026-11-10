/**
 * Work is folios inside folios: any folio can have a type (a task, a bug, a project...),
 * tags, an owner, a target date, and relationships to other folios. Readiness ("can this be started?")
 * is worked out from a folio's status and the folios it is blocked by.
 */

/** Kinds of work a folio can be. A folio may use another lowercase type of its own. */
export const FOLIO_TYPES = ['project', 'task', 'ticket', 'request', 'support', 'bug', 'feature', 'review', 'investigation', 'epic'];
/** Links between folios, stored on the folio they start from. Containment (a parent) is the folder itself. */
export const RELATIONSHIP_TYPES = ['blocked_by', 'related', 'discovered_from', 'duplicate_of', 'supersedes'];
/** Statuses that mean the work is over: a folio blocked only by these is not blocked. */
export const DONE_STATUSES = ['completed', 'archived'];
export const READINESS_STATES = ['ready', 'in_progress', 'waiting', 'blocked', 'draft', 'done'];

const FOLIO_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
export const isFolioId = (s) => typeof s === 'string' && FOLIO_ID.test(s);

/** Tags as written: trimmed, unique (ignoring case), in order. Accepts an array or a comma-separated string. */
export function normalizeTags(v) {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  const out = [];
  for (const t of list.map((x) => String(x).trim()).filter(Boolean)) if (!out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t.slice(0, 40));
  return out;
}

/** Returns a loop (array of ids) in one relationship type among `nodes` ([{ id, relationships }]), or null. */
export function findCycle(nodes, type) {
  const next = new Map(nodes.map((t) => [t.id, (t.relationships || []).filter((r) => r.type === type).map((r) => r.target)]));
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
  for (const id of next.keys())
    if (!state.get(id)) {
      const c = visit(id);
      if (c) return c;
    }
  return null;
}

/** Would adding `from --type--> to` make a loop (or point at itself)? */
export function wouldCycle(nodes, from, type, to) {
  if (from === to) return [from, to];
  if (type !== 'blocked_by') return null;
  const known = nodes.some((n) => n.id === from) ? nodes : [...nodes, { id: from, relationships: [] }];
  return findCycle(known.map((t) => (t.id === from ? { ...t, relationships: [...(t.relationships || []), { type, target: to }] } : t)), type);
}

/**
 * Readiness in ordinary language, from a folio's own fields and the status of the folios blocking it.
 * `statusOf(id)` returns another folio's status, or undefined when it is unknown (unknown blockers count as open).
 * Returns { state, ready, reasons, blocked_by? } with state one of READINESS_STATES.
 */
export function readiness(m, statusOf = () => undefined) {
  const status = m?.status || 'active';
  if (DONE_STATUSES.includes(status)) return { ready: false, state: 'done', reasons: [status === 'archived' ? 'Archived.' : 'Done.'] };
  const open = (m.relationships || []).filter((r) => r.type === 'blocked_by').map((r) => r.target).filter((id) => !DONE_STATUSES.includes(statusOf(id)));
  const reasons = [];
  if (m.hold) reasons.push(`On hold${m.hold.reason ? `: ${m.hold.reason}` : ''}.`);
  if (open.length) reasons.push(`Waiting for ${open.join(', ')} to be done.`);
  if (reasons.length) return { ready: false, state: 'blocked', reasons, blocked_by: open };
  if (status === 'draft') return { ready: false, state: 'draft', reasons: ['Still a draft.'] };
  if (m.waiting_on) return { ready: false, state: 'waiting', reasons: [`Waiting on ${m.waiting_on}.`] };
  if (status === 'waiting') return { ready: false, state: 'waiting', reasons: ['Waiting.'] };
  if (status === 'review') return { ready: false, state: 'waiting', reasons: ['In review.'] };
  if (status === 'backlog' || status === 'planned') return { ready: true, state: 'ready', reasons: ['Not started, and nothing unfinished blocks it.'] };
  return { ready: false, state: 'in_progress', reasons: ['In progress.'] };
}
