/**
 * Pasted or typed text: is it Markdown, HTML or plain text? The answer picks the file type a note is saved as
 * (notes/<date>-<title>.md, .html or .txt). Detection is a best guess from the text alone, so every interface
 * offers a way to choose another type before saving (`as` on an intake item) and after (`folio.setTextFormat`).
 */

export const TEXT_FORMATS = Object.freeze({
  markdown: Object.freeze({ ext: 'md', type: 'text/markdown', label: 'Markdown' }),
  html: Object.freeze({ ext: 'html', type: 'text/html', label: 'HTML' }),
  text: Object.freeze({ ext: 'txt', type: 'text/plain', label: 'Plain text' }),
});

const EXT_FORMAT = { md: 'markdown', markdown: 'markdown', html: 'html', htm: 'html', txt: 'text', text: 'text' };

/** The text format a file name's extension stands for ('markdown', 'html', 'text'), or null. */
export function textFormatOf(name) {
  const ext = (/\.([a-z0-9]{1,10})$/i.exec(name || '')?.[1] || '').toLowerCase();
  return EXT_FORMAT[ext] || null;
}

const HTML_TAG = /<\/?(?:p|div|span|h[1-6]|ul|ol|li|table|thead|tbody|tr|td|th|br|hr|a|strong|em|b|i|u|img|pre|code|blockquote|section|article|header|footer|main|nav|figure|figcaption|meta|style|font|dl|dt|dd)\b[^<>]*>/gi;
const HTML_DOC = /^\s*(?:<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]|<meta\s)/i;

const MARKDOWN_SIGNS = [
  // [name, weight, test]
  ['heading', 2, (t) => /^#{1,6}[ \t]+\S/m.test(t) || /^\S.*\n(?:=+|-+)[ \t]*$/m.test(t.replace(/^\s*[-*_]{3,}\s*$/gm, ''))],
  ['code fence', 2, (t) => /^[ \t]{0,3}(?:```|~~~)/m.test(t)],
  ['table', 2, (t) => /^[ \t]*\|?[^\n|]*\|[^\n]*\n[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/m.test(t)],
  ['checklist', 2, (t) => /^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]/m.test(t)],
  ['link', 1, (t) => /\[[^\]\n]+\]\((?:https?:\/\/|\/|#|mailto:)[^)\s]*\)/.test(t) || /^\[[^\]\n]+\]:[ \t]*\S+/m.test(t)],
  ['bold or italic', 1, (t) => /(?:\*\*|__)[^*_\n]+(?:\*\*|__)/.test(t) || /(?:^|[\s(])_[^_\n]+_(?=[\s).,!?]|$)/m.test(t)],
  ['bullet list', 1, (t) => (t.match(/^[ \t]{0,3}[-*+][ \t]+\S/gm) || []).length >= 2],
  ['numbered list', 1, (t) => (t.match(/^[ \t]{0,3}\d{1,3}[.)][ \t]+\S/gm) || []).length >= 2],
  ['quote', 1, (t) => /^[ \t]{0,3}>[ \t]?\S/m.test(t)],
  ['inline code', 1, (t) => /`[^`\n]+`/.test(t)],
  ['rule', 1, (t) => /^[ \t]{0,3}(?:\*[ \t]*){3,}$|^[ \t]{0,3}(?:-[ \t]*){3,}$|^[ \t]{0,3}(?:_[ \t]*){3,}$/m.test(t)],
  ['image', 1, (t) => /!\[[^\]\n]*\]\([^)\s]+\)/.test(t)],
];

/**
 * Guess the format of a piece of text. Returns { format: 'markdown' | 'html' | 'text', reasons, ...TEXT_FORMATS[format] }.
 * HTML: a full document, or text that is mostly markup (starts with a tag and has several). Markdown: two or more
 * signs (a heading, fence or table counts double); a long bullet list alone also counts. Otherwise plain text.
 */
export function detectTextFormat(input) {
  const text = String(input ?? '').replace(/^﻿/, '');
  const trimmed = text.trim();
  const out = (format, reasons) => ({ format, ...TEXT_FORMATS[format], reasons });
  if (!trimmed) return out('text', ['empty']);

  const tags = trimmed.match(HTML_TAG) || [];
  const closing = tags.filter((t) => t.startsWith('</')).length;
  if (HTML_DOC.test(trimmed)) return out('html', ['an HTML document']);
  const markupShare = tags.join('').length / trimmed.length;
  if (/^<[a-z!]/i.test(trimmed) && /[>]$/.test(trimmed) && tags.length >= 2 && closing >= 1) return out('html', [`${tags.length} HTML tags`]);
  if (tags.length >= 6 && closing >= 3 && markupShare > 0.15) return out('html', [`${tags.length} HTML tags`]);

  // Markdown signs, ignoring fenced code (which could hold anything).
  const prose = trimmed.replace(/^[ \t]{0,3}(```|~~~)[^\n]*\n[\s\S]*?^[ \t]{0,3}\1[ \t]*$/gm, '```\n```');
  const found = MARKDOWN_SIGNS.filter(([, , test]) => test(prose));
  let score = found.reduce((n, [, w]) => n + w, 0);
  const bullets = (prose.match(/^[ \t]{0,3}[-*+][ \t]+\S/gm) || []).length;
  if (bullets >= 3) score += 1;
  if (score >= 2) return out('markdown', found.map(([name]) => name));
  return out('text', found.length ? [`only ${found.map(([n]) => n).join(', ')}`] : ['no Markdown or HTML structure']);
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const decodeEntities = (s) => s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+\d?);/gi, (m, e) => {
  const k = e.toLowerCase();
  if (ENTITIES[k]) return ENTITIES[k];
  if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16) || 32);
  if (k.startsWith('#')) return String.fromCodePoint(Number(k.slice(1)) || 32);
  return m;
});

/** Readable text from HTML: scripts and styles dropped, block tags become line breaks. */
export function htmlToText(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre|section|article|header|footer|table|ul|ol|dl|dt|dd)>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A short title for text in a given format: the first heading, an HTML <title> or <h1>, else the first line. */
export function titleOfText(input, format = detectTextFormat(input).format) {
  const text = String(input ?? '');
  let line = '';
  if (format === 'html') {
    const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text) || /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(text);
    line = m ? htmlToText(m[1]) : htmlToText(text).split('\n').find((l) => l.trim()) || '';
  } else if (format === 'markdown') {
    const m = /^#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(text);
    line = (m ? m[1] : text.split('\n').find((l) => l.trim()) || '')
      .replace(/^[ \t]*(?:[-*+]|\d+[.)]|>)[ \t]+/, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`~]+/g, '');
  } else line = text.split('\n').find((l) => l.trim()) || '';
  return line.trim().slice(0, 120);
}
