import { ValidationError } from './errors.js';
import { htmlToText } from './text-format.js';
import { TICKET_PRIORITIES, TICKET_TYPES } from './tickets.js';

/**
 * Importing work from other tools. An export (a JSON file, or JSON pasted as text) is recognised by its shape and
 * turned into tickets. Recognised formats:
 *
 *   asana          Asana's JSON export or API responses: { data: [task, ...] }, { data: task } or [task, ...].
 *                  Subtasks, sections, tags, assignees, due dates, completion, a "Priority" custom field,
 *                  dependencies and comments (stories) are kept.
 *   trello         A Trello board export: { cards, lists, labels, actions? }.
 *   folio-tickets  { tickets: [{ title, description?, type?, status?, priority?, tags?, ... }] }, for agents and scripts.
 *
 * Each imported ticket remembers where it came from in `external` ({ source, id, url }), so importing the same
 * export again skips what is already there. Nothing else from the export is kept in the folio.
 */

export const MAX_IMPORT_TICKETS = 500;

const str = (v) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const day = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : undefined);

function priorityFrom(value) {
  const v = str(value).toLowerCase();
  if (!v) return undefined;
  if (/urgent|critical|highest|blocker|p0|asap/.test(v)) return 'urgent';
  if (/high|p1|important/.test(v)) return 'high';
  if (/low|p3|p4|minor|trivial/.test(v)) return 'low';
  if (/med|normal|p2|moderate/.test(v)) return 'normal';
  return undefined;
}
const typeFrom = (value) => {
  const v = str(value).toLowerCase().trim();
  return TICKET_TYPES.find((t) => t === v || `${t}s` === v) || (/defect|issue/.test(v) ? 'bug' : undefined);
};
function statusFromLabel(label) {
  const v = str(label).toLowerCase();
  if (/in[ -]?progress|doing|working|started|wip/.test(v)) return 'in_progress';
  if (/blocked|on hold|waiting/.test(v)) return 'blocked';
  return undefined;
}
const notSection = (name) => !/^(untitled section|\(no section\)|no section)$/i.test(str(name).trim());

// ---- Asana ----

const asanaTasksOf = (doc) => {
  const d = doc && typeof doc === 'object' && !Array.isArray(doc) && 'data' in doc ? doc.data : doc;
  return Array.isArray(d) ? d : d && typeof d === 'object' ? [d] : [];
};
const looksLikeAsanaTask = (t) =>
  t && typeof t === 'object' && typeof t.gid === 'string' && typeof t.name === 'string' && (t.resource_type === 'task' || 'completed' in t || 'memberships' in t || 'notes' in t || 'html_notes' in t || 'assignee' in t);

function asanaDetect(doc) {
  const tasks = asanaTasksOf(doc);
  if (!tasks.length) return null;
  const good = tasks.filter(looksLikeAsanaTask).length;
  if (good / tasks.length < 0.8) return null;
  let total = 0;
  let sub = 0;
  let sections = new Set();
  const walk = (list, depth) => {
    for (const t of list) {
      if (!looksLikeAsanaTask(t)) continue;
      if (t.resource_subtype === 'section' || t.is_rendered_as_separator) {
        sections.add(t.name.replace(/:$/, ''));
        continue;
      }
      total++;
      if (depth) sub++;
      for (const m of t.memberships || []) if (m?.section?.name && notSection(m.section.name)) sections.add(m.section.name);
      if (Array.isArray(t.subtasks)) walk(t.subtasks, depth + 1);
    }
  };
  walk(tasks, 0);
  if (!total) return null;
  const project = tasks.flatMap((t) => (t.memberships || []).map((m) => m?.project?.name).concat((t.projects || []).map((p) => p?.name))).find(Boolean);
  return { tickets: total, subtasks: sub, sections: sections.size, ...(project ? { project } : {}) };
}

function asanaPlan(doc) {
  const out = [];
  let currentSection = null; // older exports mark sections with separator tasks, in order
  const visit = (t, parentGid) => {
    if (!looksLikeAsanaTask(t)) return;
    if (t.resource_subtype === 'section' || t.is_rendered_as_separator) {
      currentSection = t.name.replace(/:$/, '').trim();
      return;
    }
    const sections = [...new Set([...(t.memberships || []).map((m) => m?.section?.name).filter(Boolean), ...(currentSection && !parentGid ? [currentSection] : [])])].filter(notSection);
    const fields = Array.isArray(t.custom_fields) ? t.custom_fields : [];
    const fieldValue = (f) => f?.enum_value?.name ?? f?.display_value ?? f?.text_value ?? f?.number_value ?? (Array.isArray(f?.multi_enum_values) ? f.multi_enum_values.map((v) => v.name).join(', ') : null);
    const pField = fields.find((f) => /priority/i.test(str(f?.name)));
    const tField = fields.find((f) => /^(type|kind|category|ticket type)$/i.test(str(f?.name).trim()));
    const sField = fields.find((f) => /^status$/i.test(str(f?.name).trim()));
    const others = fields.filter((f) => f !== pField && f !== tField && f !== sField && fieldValue(f) !== null && fieldValue(f) !== '');
    const notes = str(t.notes).trim() || (t.html_notes ? htmlToText(t.html_notes) : '');
    const footer = [
      ...(t.assignee?.name ? [`Assignee in Asana: ${t.assignee.name}`] : []),
      ...others.map((f) => `${str(f.name)}: ${fieldValue(f)}`),
      ...(t.start_on ? [`Start: ${t.start_on}`] : []),
      `Imported from Asana${t.permalink_url ? `: ${t.permalink_url}` : ` (task ${t.gid})`}`,
    ];
    const status = t.completed ? 'closed' : statusFromLabel(fieldValue(sField)) || sections.map(statusFromLabel).find(Boolean) || 'open';
    const comments = (Array.isArray(t.stories) ? t.stories : [])
      .filter((s) => s && (s.type === 'comment' || s.resource_subtype === 'comment_added') && str(s.text).trim())
      .map((s) => ({ text: str(s.text), author: s.created_by?.name || null, at: s.created_at || null }));
    out.push({
      key: t.gid,
      title: t.name.trim() || `Asana task ${t.gid}`,
      description: [notes, footer.join('\n')].filter(Boolean).join('\n\n---\n'),
      type: typeFrom(fieldValue(tField)) || (t.resource_subtype === 'approval' ? 'review' : 'request'),
      status,
      ...(status === 'closed' ? { resolution: 'completed' } : {}),
      priority: priorityFrom(fieldValue(pField)) || 'normal',
      tags: [...sections, ...(t.tags || []).map((g) => g?.name).filter(Boolean), ...(t.resource_subtype === 'milestone' ? ['milestone'] : [])],
      ...(t.assignee ? { owner: t.assignee.email || t.assignee.name || undefined } : {}),
      ...(day(t.due_on || t.due_at) ? { target_date: day(t.due_on || t.due_at) } : {}),
      external: { source: 'asana', id: t.gid, ...(t.permalink_url ? { url: t.permalink_url } : {}), ...(t.created_at ? { created_at: t.created_at } : {}), ...(t.completed_at ? { completed_at: t.completed_at } : {}) },
      ...(t.permalink_url ? { links: [{ type: 'url', label: 'Asana task', url: t.permalink_url }] } : {}),
      parent: parentGid || t.parent?.gid || null,
      blocked_by: (t.dependencies || []).map((d) => d?.gid).filter(Boolean),
      comments,
    });
    for (const s of Array.isArray(t.subtasks) ? t.subtasks : []) visit(s, t.gid);
  };
  for (const t of asanaTasksOf(doc)) visit(t, null);
  return out;
}

// ---- Trello ----

function trelloDetect(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.cards) || !Array.isArray(doc.lists)) return null;
  const cards = doc.cards.filter((c) => c && typeof c.id === 'string' && typeof c.name === 'string' && 'idList' in c);
  if (!cards.length || cards.length / doc.cards.length < 0.8) return null;
  return { tickets: cards.length, lists: doc.lists.length, ...(doc.name ? { project: doc.name } : {}) };
}

function trelloPlan(doc) {
  const lists = new Map(doc.lists.map((l) => [l.id, l]));
  const labels = new Map((doc.labels || []).map((l) => [l.id, l.name || l.color]));
  const comments = new Map();
  for (const a of doc.actions || []) {
    if (a?.type !== 'commentCard' || !a.data?.card?.id || !str(a.data?.text).trim()) continue;
    comments.set(a.data.card.id, [...(comments.get(a.data.card.id) || []), { text: a.data.text, author: a.memberCreator?.fullName || null, at: a.date || null }]);
  }
  return doc.cards
    .filter((c) => c && typeof c.id === 'string' && typeof c.name === 'string')
    .map((c) => {
      const list = lists.get(c.idList);
      const done = c.dueComplete || /^(done|complete[d]?|finished|shipped)$/i.test(str(list?.name).trim());
      const status = done ? 'closed' : c.closed || list?.closed ? 'cancelled' : statusFromLabel(list?.name) || 'open';
      const tagNames = [...(c.labels || []).map((l) => l?.name || l?.color), ...(c.idLabels || []).map((id) => labels.get(id))].filter(Boolean);
      return {
        key: c.id,
        title: c.name.trim() || `Trello card ${c.id}`,
        description: [str(c.desc).trim(), `Imported from Trello${c.shortUrl || c.url ? `: ${c.shortUrl || c.url}` : ''}`].filter(Boolean).join('\n\n---\n'),
        type: 'request',
        status,
        ...(status === 'closed' ? { resolution: 'completed' } : {}),
        priority: priorityFrom(tagNames.find((n) => priorityFrom(n))) || 'normal',
        tags: [...(list?.name ? [list.name] : []), ...tagNames.filter((n) => !priorityFrom(n))],
        ...(day(c.due) ? { target_date: day(c.due) } : {}),
        external: { source: 'trello', id: c.id, ...(c.shortUrl || c.url ? { url: c.shortUrl || c.url } : {}) },
        ...(c.shortUrl || c.url ? { links: [{ type: 'url', label: 'Trello card', url: c.shortUrl || c.url }] } : {}),
        parent: null,
        blocked_by: [],
        comments: (comments.get(c.id) || []).reverse(),
      };
    });
}

// ---- Folio's own ticket list ----

function folioTicketsDetect(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !Array.isArray(doc.tickets) || !doc.tickets.length) return null;
  if (!doc.tickets.every((t) => t && typeof t === 'object' && typeof t.title === 'string')) return null;
  return { tickets: doc.tickets.length, ...(doc.title ? { project: str(doc.title) } : {}) };
}

function folioTicketsPlan(doc) {
  return doc.tickets.map((t, i) => {
    // Entries without an id get a positional key that cannot collide with a real id.
    const key = t.id ?? t.key ?? t.external?.id;
    const k = key === undefined || key === null || key === '' ? `#${i + 1}` : str(key);
    const status = ['open', 'in_progress', 'blocked', 'resolved', 'closed', 'cancelled'].includes(t.status) ? t.status : 'open';
    return {
      key: k,
      title: t.title,
      description: str(t.description),
      type: typeFrom(t.type) || 'request',
      status,
      ...(status === 'closed' ? { resolution: str(t.resolution) || 'completed' } : t.resolution ? { resolution: str(t.resolution) } : {}),
      priority: TICKET_PRIORITIES.includes(t.priority) ? t.priority : priorityFrom(t.priority) || 'normal',
      tags: Array.isArray(t.tags) ? t.tags.map(str) : typeof t.tags === 'string' ? t.tags.split(',') : [],
      ...(t.owner ? { owner: str(t.owner) } : {}),
      ...(t.outcome ? { outcome: str(t.outcome) } : {}),
      ...(day(t.target_date) ? { target_date: day(t.target_date) } : {}),
      external: { source: str(t.external?.source || doc.source || 'folio-tickets'), id: k, ...(t.external?.url || t.url ? { url: str(t.external?.url || t.url) } : {}) },
      ...(Array.isArray(t.links) ? { links: t.links.filter((l) => l && (l.url || l.path)) } : {}),
      parent: t.parent != null ? str(t.parent) : null,
      blocked_by: (Array.isArray(t.blocked_by) ? t.blocked_by : []).map(str),
      comments: (Array.isArray(t.comments) ? t.comments : []).map((c) => (typeof c === 'string' ? { text: c } : { text: str(c?.text), author: c?.author || null, at: c?.at || null })).filter((c) => c.text.trim()),
    };
  });
}

export const IMPORTERS = Object.freeze([
  { format: 'asana', label: 'Asana', detect: asanaDetect, plan: asanaPlan },
  { format: 'trello', label: 'Trello', detect: trelloDetect, plan: trelloPlan },
  { format: 'folio-tickets', label: 'Folio tickets', detect: folioTicketsDetect, plan: folioTicketsPlan },
]);
export const IMPORT_FORMATS = IMPORTERS.map((i) => i.format);

/** Parse JSON text (or bytes) if it is JSON; else undefined. */
export function parseJsonText(input, max = 30 * 1024 * 1024) {
  const text = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: false }).decode(input);
  const t = text.replace(/^﻿/, '').trim();
  if (!t || t.length > max || !/^[[{]/.test(t)) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/**
 * Which importer, if any, recognises this parsed JSON. Returns { format, label, tickets, ... } or null.
 * `format` forces one importer (null if it does not recognise the document).
 */
export function detectImport(doc, { format } = {}) {
  for (const imp of IMPORTERS) {
    if (format && format !== 'auto' && imp.format !== format) continue;
    const found = imp.detect(doc);
    if (found) return { format: imp.format, label: imp.label, ...found };
  }
  return null;
}

/** The ticket plans for a document: [{ key, title, description, ..., parent, blocked_by, comments }]. */
export function planImport(doc, { format } = {}) {
  const found = detectImport(doc, { format });
  if (!found) throw new ValidationError(`This is not an export Folio can import (${IMPORTERS.map((i) => i.label).join(', ')})`);
  const plans = IMPORTERS.find((i) => i.format === found.format).plan(doc);
  if (plans.length > MAX_IMPORT_TICKETS) throw new ValidationError(`That export has ${plans.length} tickets; Folio imports up to ${MAX_IMPORT_TICKETS} at a time. Split it into smaller exports.`);
  return { ...found, plans };
}
