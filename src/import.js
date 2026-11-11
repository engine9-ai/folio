import { ValidationError } from './errors.js';
import { htmlToText } from './text-format.js';
import { FOLIO_STATUSES } from './manifest.js';
import { FOLIO_TYPES, RESERVED_TYPES } from './relations.js';

/**
 * Importing work from other tools. An export (a JSON file, or JSON pasted as text) is recognised by its shape and
 * turned into folios. Recognised formats:
 *
 *   asana          Asana's JSON export or API responses: { data: [item, ...] }, { data: item } or [item, ...]
 *                  (Asana's JSON calls its items "tasks"; here each becomes a folio with no type unless a
 *                  "Type" field gives one). Sub-items, sections, tags, assignees, due dates, completion,
 *                  custom fields (kept as text), dependencies and comments (stories) are kept.
 *   trello         A Trello board export: { cards, lists, labels, actions? }.
 *   folio-list     { folios: [{ title, description?, type?, status?, tags?, ... }] }, for agents and scripts
 *
 * Each imported folio remembers where it came from in `external` ({ source, id, url }), so importing the same
 * export again skips what is already there. Nothing else from the export is kept in the folio.
 */

export const MAX_IMPORT_ITEMS = 500;

const str = (v) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const day = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : undefined);

const typeFrom = (value) => {
  const v = str(value).toLowerCase().trim();
  // "task" is not a folio type (SPEC 5.8): an item another tool calls a task is a folio with no type.
  return FOLIO_TYPES.find((t) => t === v || `${t}s` === v) || (/defect|issue/.test(v) ? 'bug' : undefined);
};
function statusFromLabel(label) {
  const v = str(label).toLowerCase();
  if (/in[ -]?progress|doing|working|started|wip/.test(v)) return 'active';
  if (/blocked|on hold|waiting/.test(v)) return 'waiting';
  if (/review|approv|qa\b/.test(v)) return 'review';
  if (/up ?next|upcoming|this week|planned|priorit|to ?do|scheduled/.test(v)) return 'planned';
  if (/backburner|backlog|someday|icebox|later/.test(v)) return 'backlog';
  return undefined;
}
const notSection = (name) => !/^(untitled section|\(no section\)|no section)$/i.test(str(name).trim());

// ---- Asana ----

const asanaItemsOf = (doc) => {
  const d = doc && typeof doc === 'object' && !Array.isArray(doc) && 'data' in doc ? doc.data : doc;
  return Array.isArray(d) ? d : d && typeof d === 'object' ? [d] : [];
};
const looksLikeAsanaItem = (t) =>
  t && typeof t === 'object' && typeof t.gid === 'string' && typeof t.name === 'string' && (t.resource_type === 'task' || 'completed' in t || 'memberships' in t || 'notes' in t || 'html_notes' in t || 'assignee' in t);

function asanaDetect(doc) {
  const items = asanaItemsOf(doc);
  if (!items.length) return null;
  const good = items.filter(looksLikeAsanaItem).length;
  if (good / items.length < 0.8) return null;
  let total = 0;
  let sub = 0;
  let sections = new Set();
  const walk = (list, depth) => {
    for (const t of list) {
      if (!looksLikeAsanaItem(t)) continue;
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
  walk(items, 0);
  if (!total) return null;
  const project = items.flatMap((t) => (t.memberships || []).map((m) => m?.project?.name).concat((t.projects || []).map((p) => p?.name))).find(Boolean);
  return { items: total, sub_items: sub, sections: sections.size, ...(project ? { project } : {}) };
}

function asanaPlan(doc) {
  const out = [];
  let currentSection = null; // older exports mark sections with separator items, in order
  const visit = (t, parentGid) => {
    if (!looksLikeAsanaItem(t)) return;
    if (t.resource_subtype === 'section' || t.is_rendered_as_separator) {
      currentSection = t.name.replace(/:$/, '').trim();
      return;
    }
    const sections = [...new Set([...(t.memberships || []).map((m) => m?.section?.name).filter(Boolean), ...(currentSection && !parentGid ? [currentSection] : [])])].filter(notSection);
    const fields = Array.isArray(t.custom_fields) ? t.custom_fields : [];
    const fieldValue = (f) => f?.enum_value?.name ?? f?.display_value ?? f?.text_value ?? f?.number_value ?? (Array.isArray(f?.multi_enum_values) ? f.multi_enum_values.map((v) => v.name).join(', ') : null);
    const tField = fields.find((f) => /^(type|kind|category|(task|item|ticket) type)$/i.test(str(f?.name).trim()));
    const sField = fields.find((f) => /^status$/i.test(str(f?.name).trim()));
    const others = fields.filter((f) => f !== tField && f !== sField && fieldValue(f) !== null && fieldValue(f) !== '');
    const notes = str(t.notes).trim() || (t.html_notes ? htmlToText(t.html_notes) : '');
    const footer = [
      ...(t.assignee?.name ? [`Assignee in Asana: ${t.assignee.name}`] : []),
      ...others.map((f) => `${str(f.name)}: ${fieldValue(f)}`),
      ...(t.start_on ? [`Start: ${t.start_on}`] : []),
      `Imported from Asana${t.permalink_url ? `: ${t.permalink_url}` : ` (${t.gid})`}`,
    ];
    const status = t.completed ? 'completed' : statusFromLabel(fieldValue(sField)) || sections.map(statusFromLabel).find(Boolean) || 'backlog';
    const comments = (Array.isArray(t.stories) ? t.stories : [])
      .filter((s) => s && (s.type === 'comment' || s.resource_subtype === 'comment_added') && str(s.text).trim())
      .map((s) => ({ text: str(s.text), author: s.created_by?.name || null, at: s.created_at || null }));
    out.push({
      key: t.gid,
      title: t.name.trim() || `Asana item ${t.gid}`,
      description: [notes, footer.join('\n')].filter(Boolean).join('\n\n---\n'),
      type: typeFrom(fieldValue(tField)) || (t.resource_subtype === 'approval' ? 'review' : undefined),
      status,
      ...(status === 'completed' ? { resolution: 'completed' } : {}),
      tags: [...sections, ...(t.tags || []).map((g) => g?.name).filter(Boolean), ...(t.resource_subtype === 'milestone' ? ['milestone'] : [])],
      ...(t.assignee ? { owner: t.assignee.email || t.assignee.name || undefined } : {}),
      ...(day(t.due_on || t.due_at) ? { target_date: day(t.due_on || t.due_at) } : {}),
      external: { source: 'asana', id: t.gid, ...(t.permalink_url ? { url: t.permalink_url } : {}), ...(t.created_at ? { created_at: t.created_at } : {}), ...(t.completed_at ? { completed_at: t.completed_at } : {}) },
      ...(t.permalink_url ? { links: [{ type: 'url', label: 'Asana', url: t.permalink_url }] } : {}),
      parent: parentGid || t.parent?.gid || null,
      blocked_by: (t.dependencies || []).map((d) => d?.gid).filter(Boolean),
      comments,
    });
    for (const s of Array.isArray(t.subtasks) ? t.subtasks : []) visit(s, t.gid);
  };
  for (const t of asanaItemsOf(doc)) visit(t, null);
  return out;
}

// ---- Trello ----

function trelloDetect(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.cards) || !Array.isArray(doc.lists)) return null;
  const cards = doc.cards.filter((c) => c && typeof c.id === 'string' && typeof c.name === 'string' && 'idList' in c);
  if (!cards.length || cards.length / doc.cards.length < 0.8) return null;
  return { items: cards.length, lists: doc.lists.length, ...(doc.name ? { project: doc.name } : {}) };
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
      const status = done ? 'completed' : c.closed || list?.closed ? 'archived' : statusFromLabel(list?.name) || 'backlog';
      const tagNames = [...(c.labels || []).map((l) => l?.name || l?.color), ...(c.idLabels || []).map((id) => labels.get(id))].filter(Boolean);
      return {
        key: c.id,
        title: c.name.trim() || `Trello card ${c.id}`,
        description: [str(c.desc).trim(), `Imported from Trello${c.shortUrl || c.url ? `: ${c.shortUrl || c.url}` : ''}`].filter(Boolean).join('\n\n---\n'),
        status,
        ...(status === 'completed' ? { resolution: 'completed' } : status === 'archived' ? { resolution: 'cancelled' } : {}),
        tags: [...(list?.name ? [list.name] : []), ...tagNames],
        ...(day(c.due) ? { target_date: day(c.due) } : {}),
        external: { source: 'trello', id: c.id, ...(c.shortUrl || c.url ? { url: c.shortUrl || c.url } : {}) },
        ...(c.shortUrl || c.url ? { links: [{ type: 'url', label: 'Trello card', url: c.shortUrl || c.url }] } : {}),
        parent: null,
        blocked_by: [],
        comments: (comments.get(c.id) || []).reverse(),
      };
    });
}

// ---- Folio's own list ----

const listOf = (doc) => (doc && typeof doc === 'object' && !Array.isArray(doc) ? (Array.isArray(doc.folios) ? doc.folios : null) : null);

function folioListDetect(doc) {
  const list = listOf(doc);
  if (!list?.length || !list.every((t) => t && typeof t === 'object' && typeof t.title === 'string')) return null;
  return { items: list.length, ...(doc.title ? { project: str(doc.title) } : {}) };
}

function folioListPlan(doc) {
  return listOf(doc).map((t, i) => {
    // Entries without an id get a positional key that cannot collide with a real id.
    const key = t.id ?? t.key ?? t.external?.id;
    const k = key === undefined || key === null || key === '' ? `#${i + 1}` : str(key);
    const status = FOLIO_STATUSES.includes(t.status) ? t.status : statusFromLabel(t.status) || 'backlog';
    return {
      key: k,
      title: t.title,
      description: str(t.description),
      type: typeFrom(t.type) || (t.type && /^[a-z][a-z0-9_-]{0,39}$/.test(t.type) && !RESERVED_TYPES.includes(t.type) ? t.type : undefined),
      status,
      ...(status === 'completed' ? { resolution: str(t.resolution) || 'completed' } : t.resolution ? { resolution: str(t.resolution) } : {}),
      tags: Array.isArray(t.tags) ? t.tags.map(str) : typeof t.tags === 'string' ? t.tags.split(',') : [],
      ...(t.owner ? { owner: str(t.owner) } : {}),
      ...(t.outcome ? { outcome: str(t.outcome) } : {}),
      ...(day(t.target_date) ? { target_date: day(t.target_date) } : {}),
      external: { source: str(t.external?.source || doc.source || 'folio-list'), id: k, ...(t.external?.url || t.url ? { url: str(t.external?.url || t.url) } : {}) },
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
  { format: 'folio-list', label: 'Folio list', detect: folioListDetect, plan: folioListPlan },
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
 * Which importer, if any, recognises this parsed JSON. Returns { format, label, items, ... } or null.
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

/** The import plans for a document: [{ key, title, description, ..., parent, blocked_by, comments }]. */
export function planImport(doc, { format } = {}) {
  const found = detectImport(doc, { format });
  if (!found) throw new ValidationError(`This is not an export Folio can import (${IMPORTERS.map((i) => i.label).join(', ')})`);
  const plans = IMPORTERS.find((i) => i.format === found.format).plan(doc);
  if (plans.length > MAX_IMPORT_ITEMS) throw new ValidationError(`That export has ${plans.length} items; Folio imports up to ${MAX_IMPORT_ITEMS} at a time. Split it into smaller exports.`);
  return { ...found, plans };
}
