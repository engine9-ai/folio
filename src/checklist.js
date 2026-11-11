import { ValidationError } from './errors.js';
import { scrubText } from './privacy.js';

/**
 * A folio's checklist (SPEC 5.9): plain Markdown checkboxes under a "Checklist" heading in its README.md.
 *
 *   ## Checklist
 *   - [x] Confirm launch date with Tim
 *   - [ ] Send DNS change request
 *
 * Simple and quick on purpose: an item is a line of text that is done or not. No owners, dates, nesting, blockers or
 * comments, and ticking one changes nothing else (status, readiness, the conversation). Anything that needs more is
 * a sub-folio; an item can be turned into one.
 *
 * Items are numbered from 1 in the order they appear. Lines in the section that are not items are left alone, and
 * the rest of the README is never touched.
 */

export const CHECKLIST_FILE = 'README.md';
export const CHECKLIST_HEADING = 'Checklist';
export const MAX_CHECKLIST_ITEMS = 50;
export const MAX_CHECKLIST_TEXT = 300;

const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const ITEM = /^([ \t]*)([-*+])[ \t]+\[([ xX])\][ \t]+(.*)$/;
const IS_CHECKLIST = /^checklist$/i;

/**
 * Where the checklist is in a README and what it holds:
 *   { found, heading: line index or -1, end: line index after the section, items: [{ n, done, text, line }] }
 */
export function parseChecklist(text) {
  const lines = String(text ?? '').split('\n');
  let heading = -1;
  let level = 0;
  let end = lines.length;
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^[ \t]*(```|~~~)/.test(lines[i])) fence = !fence;
    if (fence) continue;
    const h = HEADING.exec(lines[i]);
    if (!h) continue;
    if (heading === -1 && IS_CHECKLIST.test(h[2].trim())) {
      heading = i;
      level = h[1].length;
    } else if (heading !== -1 && h[1].length <= level) {
      end = i;
      break;
    }
  }
  const items = [];
  if (heading !== -1)
    for (let i = heading + 1; i < end; i++) {
      const m = ITEM.exec(lines[i]);
      if (m) items.push({ n: items.length + 1, done: m[3] !== ' ', text: m[4].trim(), line: i });
    }
  return { found: heading !== -1, heading, end, items, lines };
}

/** { done, total } for a README's checklist, or null when it has none (or no items). */
export function checklistCounts(text) {
  const { items } = parseChecklist(text);
  return items.length ? { done: items.filter((i) => i.done).length, total: items.length } : null;
}

/** An item's text: one line, trimmed, scrubbed of card numbers and credentials. */
export function cleanItemText(t) {
  const one = String(t ?? '').replace(/\s+/g, ' ').trim();
  if (!one) throw new ValidationError('A checklist item needs some text');
  if (one.length > MAX_CHECKLIST_TEXT) throw new ValidationError(`A checklist item is one short line (at most ${MAX_CHECKLIST_TEXT} characters). Anything longer is a sub-folio.`);
  return scrubText(one).text;
}

/** Which item `ref` means: its number (1, "2") or its exact text (case and spacing ignored). */
export function findItem(items, ref) {
  if (typeof ref === 'number' || (typeof ref === 'string' && /^\d+$/.test(ref.trim()))) {
    const hit = items[Number(ref) - 1];
    if (!hit) throw new ValidationError(`The checklist has no item ${ref} (it has ${items.length})`);
    return hit;
  }
  if (ref && typeof ref === 'object' && ref.n !== undefined) {
    const hit = findItem(items, ref.n);
    // `expect`: the item's text as the person saw it, so a checklist changed meanwhile is not ticked in the wrong place.
    if (ref.expect !== undefined && norm(hit.text) !== norm(ref.expect)) throw new ValidationError(`The checklist changed: item ${ref.n} is now “${hit.text}”. Reload and try again.`);
    return hit;
  }
  const want = norm(ref);
  const hit = items.find((i) => norm(i.text) === want);
  if (!hit) throw new ValidationError(`No checklist item “${ref}”`);
  return hit;
}
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Apply changes to a README's checklist; returns { text, items, changed }. `changes`:
 *   { add: [text], check: [ref], uncheck: [ref], remove: [ref], rename: [{ item: ref, text }] }
 * where ref is an item's number, its text, or { n, expect }. Refs are read against the checklist as it was before
 * any change. Adding to a README with no checklist adds a "## Checklist" section at the end.
 */
export function editChecklistText(text, changes = {}) {
  const parsed = parseChecklist(text);
  const lines = [...parsed.lines];
  const list = (k) => (changes[k] === undefined || changes[k] === null ? [] : Array.isArray(changes[k]) ? changes[k] : [changes[k]]);
  let changed = 0;
  const set = (item, done) => {
    const m = ITEM.exec(lines[item.line]);
    const next = `${m[1]}${m[2]} [${done ? 'x' : ' '}] ${m[4].trim()}`;
    if (next !== lines[item.line]) {
      lines[item.line] = next;
      changed++;
    }
  };
  for (const r of list('rename')) {
    const item = findItem(parsed.items, r?.item ?? r?.n);
    const m = ITEM.exec(lines[item.line]);
    const t = cleanItemText(r?.text);
    if (t !== m[4].trim()) {
      lines[item.line] = `${m[1]}${m[2]} [${m[3]}] ${t}`;
      changed++;
    }
  }
  for (const r of list('check')) set(findItem(parsed.items, r), true);
  for (const r of list('uncheck')) set(findItem(parsed.items, r), false);
  const removed = [...new Set(list('remove').map((r) => findItem(parsed.items, r).line))].sort((a, b) => b - a);
  for (const line of removed) lines.splice(line, 1);
  changed += removed.length;

  const adds = list('add').map(cleanItemText);
  if (parsed.items.length - removed.length + adds.length > MAX_CHECKLIST_ITEMS) throw new ValidationError(`A checklist holds at most ${MAX_CHECKLIST_ITEMS} items. Bigger lists of work are folios inside the folio.`);
  if (adds.length) {
    const newLines = adds.map((t) => `- [ ] ${t}`);
    const after = parseChecklist(lines.join('\n'));
    if (after.found) {
      // After the last item, or after the heading when there are none.
      let at = after.items.length ? after.items.at(-1).line + 1 : after.heading + 1;
      if (!after.items.length && lines[at] !== undefined && lines[at].trim() === '') at++;
      if (!after.items.length && at === after.heading + 1) newLines.unshift('');
      lines.splice(at, 0, ...newLines);
    } else {
      while (lines.length && lines.at(-1).trim() === '') lines.pop();
      lines.push('', `## ${CHECKLIST_HEADING}`, '', ...newLines, '');
    }
    changed += adds.length;
  }
  const out = lines.join('\n');
  return { text: out, items: parseChecklist(out).items.map(({ n, done, text: t }) => ({ n, done, text: t })), changed };
}
