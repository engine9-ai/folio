/**
 * Just enough MIME to file an email: read the header block of an original
 * message (RFC 5322) and decode encoded-words (RFC 2047) in it. The original
 * bytes are always kept as they arrived; this only reads them.
 */

const HEADER_LINE = /^[!-9;-~]+:/; // a field name is printable ASCII except ":"

/** Does this text start like an email message (a header block with From and a typical second field)? */
export function looksLikeEmail(text) {
  if (typeof text !== 'string' || !text) return false;
  const head = headerBlock(text.slice(0, 16384));
  if (!head) return false;
  const names = new Set(head.map(([n]) => n));
  return names.has('from') && (names.has('subject') || names.has('message-id') || names.has('date') || names.has('received'));
}

function headerBlock(text) {
  const end = text.search(/\r?\n\r?\n/);
  const head = end === -1 ? text : text.slice(0, end);
  const lines = head.split(/\r?\n/);
  if (!lines.length || !HEADER_LINE.test(lines[0])) return null;
  const fields = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && fields.length) fields.at(-1)[1] += ' ' + line.trim();
    else if (HEADER_LINE.test(line)) {
      const i = line.indexOf(':');
      fields.push([line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim()]);
    } else return null; // not a header block
  }
  return fields;
}

function decodeBytes(bytes, charset) {
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** Decode RFC 2047 encoded-words such as =?UTF-8?B?...?= and =?iso-8859-1?Q?...?=. */
export function decodeEncodedWords(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/(=\?[^?]+\?[bBqQ]\?[^?]*\?=)\s+(?==\?)/g, '$1') // whitespace between encoded words is not shown
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, charset, enc, data) => {
      try {
        if (enc.toUpperCase() === 'B') {
          const bin = atob(data);
          return decodeBytes(Uint8Array.from(bin, (c) => c.charCodeAt(0)), charset);
        }
        const bytes = [];
        const s = data.replace(/_/g, ' ');
        for (let i = 0; i < s.length; i++) {
          if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
            bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
            i += 2;
          } else bytes.push(s.charCodeAt(i));
        }
        return decodeBytes(new Uint8Array(bytes), charset);
      } catch {
        return _;
      }
    });
}

/** The address part of "Name <a@b.c>" (lowercased), or the input trimmed if there are no brackets. */
export function emailAddress(value) {
  if (!value) return null;
  const m = /<([^>]+)>/.exec(value);
  const addr = (m ? m[1] : value).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(addr) ? addr : null;
}

/**
 * Header summary of an email. Returns null if the text does not start with a header block.
 * Fields: from, to, cc, subject, date (ISO when parseable, else as written), message_id, in_reply_to, references.
 */
export function parseEmailHeaders(text) {
  const head = headerBlock(String(text || '').slice(0, 65536));
  if (!head) return null;
  const get = (n) => head.find(([k]) => k === n)?.[1];
  const date = get('date');
  const parsed = date ? new Date(date) : null;
  const out = {
    from: decodeEncodedWords(get('from')) || null,
    to: decodeEncodedWords(get('to')) || null,
    cc: decodeEncodedWords(get('cc')) || null,
    subject: decodeEncodedWords(get('subject')) || null,
    date: parsed && !isNaN(parsed) ? parsed.toISOString() : date || null,
    message_id: get('message-id') || null,
    in_reply_to: get('in-reply-to') || null,
    references: get('references') || null,
  };
  for (const k of Object.keys(out)) if (out[k] === null) delete out[k];
  return out;
}

// ---- body text, for reading and summarising (the stored bytes are never changed) ----

function splitMessage(text) {
  const m = /\r?\n\r?\n/.exec(text);
  return m ? [text.slice(0, m.index), text.slice(m.index + m[0].length)] : [text, ''];
}

function partHeaders(head) {
  const out = {};
  let last = null;
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && last) out[last] += ' ' + line.trim();
    else {
      const i = line.indexOf(':');
      if (i > 0) {
        last = line.slice(0, i).trim().toLowerCase();
        out[last] = line.slice(i + 1).trim();
      }
    }
  }
  return out;
}

const param = (value, name) => {
  const m = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i').exec(value || '');
  return m ? m[1] ?? m[2] : null;
};

function decodeTransfer(body, encoding, charset) {
  const enc = String(encoding || '').toLowerCase();
  if (enc === 'base64') {
    try {
      const bin = atob(body.replace(/[^A-Za-z0-9+/=]/g, ''));
      return decodeBytes(Uint8Array.from(bin, (c) => c.charCodeAt(0)), charset);
    } catch {
      return body;
    }
  }
  if (enc === 'quoted-printable') {
    const s = body.replace(/=\r?\n/g, '');
    const bytes = [];
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
        bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        const code = s.charCodeAt(i);
        if (code < 128) bytes.push(code);
        else bytes.push(...new TextEncoder().encode(s[i]));
      }
    }
    return decodeBytes(new Uint8Array(bytes), charset);
  }
  return body;
}

const stripHtml = (html) =>
  html
    .replace(/<(script|style)[^]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n');

/** The readable text of one MIME entity: text/plain preferred, else text/html stripped; parts recurse. */
function entityText(head, body, depth = 0) {
  const h = partHeaders(head);
  const type = String(h['content-type'] || 'text/plain').toLowerCase();
  if (type.startsWith('multipart/') && depth < 8) {
    const boundary = param(h['content-type'], 'boundary');
    if (!boundary) return { plain: body, html: null };
    const parts = body.split(new RegExp(`\\r?\\n?--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \\t]*\\r?\\n?`));
    let plain = null;
    let html = null;
    for (const p of parts.slice(1)) {
      if (!p.trim()) continue;
      const [ph, pb] = splitMessage(p);
      const r = entityText(ph, pb, depth + 1);
      if (r.plain && plain === null) plain = r.plain;
      if (r.html && html === null) html = r.html;
    }
    return { plain, html };
  }
  if (/attachment/i.test(h['content-disposition'] || '')) return { plain: null, html: null };
  const decoded = decodeTransfer(body, h['content-transfer-encoding'], param(h['content-type'], 'charset'));
  if (type.startsWith('text/html')) return { plain: null, html: stripHtml(decoded) };
  if (type.startsWith('text/')) return { plain: decoded, html: null };
  return { plain: null, html: null };
}

/**
 * Headers (as parseEmailHeaders) plus the readable body text of an email. Handles plain, quoted-printable,
 * base64 and multipart messages; HTML-only messages are reduced to text. Returns null if the text is not an email.
 */
export function parseEmail(text) {
  const headers = parseEmailHeaders(text);
  if (!headers) return null;
  const [head, body] = splitMessage(String(text));
  const r = entityText(head, body);
  const out = (r.plain ?? r.html ?? '').replace(/\r\n/g, '\n').trim();
  return { headers, text: out };
}

function transferBytes(body, encoding) {
  const enc = String(encoding || '').toLowerCase();
  if (enc === 'base64') {
    try {
      const bin = atob(body.replace(/[^A-Za-z0-9+/=]/g, ''));
      return Uint8Array.from(bin, (c) => c.charCodeAt(0));
    } catch {
      /* fall through: keep the text */
    }
  }
  if (enc === 'quoted-printable') return new TextEncoder().encode(decodeTransfer(body, enc, 'utf-8'));
  return new TextEncoder().encode(body);
}

/**
 * The attachments of an email: [{ name, type, bytes }]. A part is an attachment when it says so
 * (Content-Disposition: attachment) or carries a file name. Inline text and HTML bodies are not.
 */
export function emailAttachments(text) {
  const out = [];
  const walk = (head, body, depth) => {
    const h = partHeaders(head);
    const type = String(h['content-type'] || 'text/plain').toLowerCase();
    if (type.startsWith('multipart/') && depth < 8) {
      const boundary = param(h['content-type'], 'boundary');
      if (!boundary) return;
      const parts = body.split(new RegExp(`\\r?\\n?--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \\t]*\\r?\\n?`));
      for (const p of parts.slice(1)) {
        if (!p.trim()) continue;
        const [ph, pb] = splitMessage(p);
        walk(ph, pb, depth + 1);
      }
      return;
    }
    const name = decodeEncodedWords(param(h['content-disposition'], 'filename') || param(h['content-type'], 'name'));
    const attached = /attachment/i.test(h['content-disposition'] || '') || Boolean(name);
    if (!attached || depth === 0) return;
    out.push({ name: name || 'attachment', type: type.split(';')[0].trim(), bytes: transferBytes(body, h['content-transfer-encoding']) });
  };
  const [head, body] = splitMessage(String(text || ''));
  walk(head, body, 0);
  return out;
}

/** The raw header block of a message, unchanged (folded lines kept), without the blank line after it. */
export function rawHeaderBlock(text) {
  return splitMessage(String(text || ''))[0];
}


// ---- forwarded messages and clean text ----

const FORWARD_MARKER = /^\s*(?:>\s*)*(?:begin forwarded message:?|-{2,}\s*forwarded message\s*-{2,}|-{2,}\s*original message\s*-{2,}|_{10,}|forwarded message:?)\s*$/i;
const FORWARD_FIELD = /^\s*(?:>\s*)*(from|to|cc|sent|date|subject|reply-to)\s*:\s*(.*)$/i;

/**
 * The header block of the first message forwarded inside an email body ("Begin forwarded message:",
 * "---------- Forwarded message ---------", "-----Original Message-----"): { from, to, cc, date, subject, at } with
 * `at` the line number the forwarded body starts on, or null when the body forwards nothing.
 */
export function forwardedHeaders(body) {
  const lines = String(body || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!FORWARD_MARKER.test(lines[i])) continue;
    const found = {};
    let last = null;
    let seen = 0;
    let j = i + 1;
    for (; j < Math.min(lines.length, i + 25); j++) {
      const line = lines[j];
      if (!line.replace(/^[\s>]+/, '').trim()) {
        if (seen) break;
        continue;
      }
      const m = FORWARD_FIELD.exec(line);
      if (m) {
        last = m[1].toLowerCase() === 'sent' ? 'date' : m[1].toLowerCase();
        seen++;
        found[last] = [found[last], m[2]].filter(Boolean).join(', ');
      } else if (last && /^\s+\S/.test(line)) found[last] += ` ${line.trim()}`;
      else break;
    }
    if (found.from || found.to || found.cc) return { ...found, at: j };
  }
  return null;
}

/** The address a forwarded email was originally from, lowercase, or null. */
export function forwardedFrom(body) {
  const f = forwardedHeaders(body);
  return f?.from ? emailAddress(f.from) : null;
}

const SIG = /^(?:--\s*|__+|sent from my \w+.*|get outlook for \w+.*)$/i;
const REPLY_HEAD = /^(?:on .{6,200}wrote:|-{2,}\s*original message\s*-{2,}|from:\s.+\bsent:\s.+)$/i;
const NOTICE = /^\s*(?:confidentiality notice|this (?:e-?mail|message)(?: message)?(?:, including any attachments,)? (?:is|may be) (?:confidential|intended)|disclaimer:)/i;

/**
 * The part of an email worth reading: what the sender wrote, without quoted history, signatures and legal
 * notices. For a forwarded email whose sender added nothing but a signature, the forwarded message itself (with
 * its quote marks taken off). Returns { text, trimmed } (trimmed: something was left out). Never empty when the
 * email had text: if cleaning leaves nothing, the original comes back.
 */
export function cleanEmailText(text) {
  const original = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!original) return { text: '', trimmed: false };
  const lines = original.split('\n');
  const fwd = forwardedHeaders(original);
  const strip = (ls) => {
    const out = [];
    for (const line of ls) {
      const bare = line.trim();
      if (REPLY_HEAD.test(bare) || SIG.test(bare) || NOTICE.test(bare)) break;
      if (/^>/.test(bare)) continue;
      out.push(line);
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  };
  let own = fwd ? strip(lines.slice(0, lines.findIndex((l) => FORWARD_MARKER.test(l)))) : strip(lines);
  if (fwd) {
    const quoted = lines.slice(fwd.at).map((l) => l.replace(/^\s*(?:>\s?)+/, ''));
    const inner = strip(quoted);
    const head = [fwd.from && `From: ${fwd.from}`, fwd.date && `Date: ${fwd.date}`, fwd.subject && `Subject: ${fwd.subject}`].filter(Boolean).join('\n');
    // A forward whose own text is only a signature reads as the forwarded message.
    own = own.length > 40 ? `${own}\n\nForwarded message\n${head}\n\n${inner}` : `Forwarded message\n${head}\n\n${inner}`;
  }
  own = own.replace(/[￼​]+/g, '').trim();
  if (!own) return { text: original, trimmed: false };
  return { text: own, trimmed: own.length < original.length };
}

// ---- the parts of a message, and a copy of it with its attachments kept as files ----

/** Bytes as a "binary string" (one char per byte), so MIME structure can be rewritten without changing any byte. */
export const binaryString = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return s;
};
/** The bytes of a binary string (see binaryString). */
export const binaryBytes = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

/** Inline images smaller than this (signature logos, icons) stay inside the email; everything else is a file. */
export const INLINE_KEEP_BYTES = 32 * 1024;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function splitKeep(text) {
  const m = /\r?\n\r?\n/.exec(text);
  return m ? [text.slice(0, m.index), m[0], text.slice(m.index + m[0].length)] : [text, '', ''];
}

function leafBytes(body, encoding) {
  const enc = String(encoding || '').toLowerCase();
  if (enc === 'base64') {
    try {
      return binaryBytes(atob(body.replace(/[^A-Za-z0-9+/=]/g, '')));
    } catch {
      /* fall through: keep the text */
    }
  }
  if (enc === 'quoted-printable') {
    const s = body.replace(/=\r?\n/g, '');
    const out = [];
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
        out.push(parseInt(s.slice(i + 1, i + 3), 16));
        i += 2;
      } else out.push(s.charCodeAt(i) & 0xff);
    }
    return new Uint8Array(out);
  }
  return binaryBytes(body);
}

/**
 * Walk the MIME tree of a message (a binary string) and let `visit(part)` replace leaf entities. `part` is
 * { index, name, type, content_type, disposition, content_id, inline, attachment, size, bytes(), headers } and
 * visit returns the replacement entity (headers, blank line, body) or null to keep it. Returns the new message;
 * everything not replaced is kept byte for byte.
 */
function rewriteMime(raw, visit) {
  let index = 0;
  const walk = (text, depth) => {
    const [head, sep, body] = splitKeep(text);
    const h = partHeaders(head);
    const contentType = h['content-type'] || 'text/plain';
    const type = contentType.split(';')[0].trim().toLowerCase();
    if (type.startsWith('multipart/') && depth < 8) {
      const boundary = param(contentType, 'boundary');
      if (!boundary) return text;
      const marks = [...body.matchAll(new RegExp(`(?:^|\\r?\\n)--${escapeRe(boundary)}(--)?[ \\t]*(?=\\r?\\n|$)`, 'g'))];
      if (!marks.length) return text;
      let out = body.slice(0, marks[0].index + marks[0][0].length);
      for (let i = 0; i < marks.length; i++) {
        const from = marks[i].index + marks[i][0].length;
        if (marks[i][1] || i === marks.length - 1) {
          out += body.slice(from); // the closing delimiter and what follows it
          break;
        }
        const seg = body.slice(from, marks[i + 1].index);
        const nl = /^\r?\n/.exec(seg)?.[0] || '';
        out += nl + walk(seg.slice(nl.length), depth + 1) + marks[i + 1][0];
      }
      return head + sep + out;
    }
    if (depth === 0) return text;
    const disposition = h['content-disposition'] || '';
    const name = decodeEncodedWords(param(disposition, 'filename') || param(contentType, 'name')) || null;
    const contentId = h['content-id'] || null;
    const isAttachment = /^\s*attachment/i.test(disposition);
    const inline = !isAttachment && (/^\s*inline/i.test(disposition) || Boolean(contentId));
    const encoding = h['content-transfer-encoding'];
    let bytes = null;
    const part = {
      index: index++,
      name,
      type,
      content_type: contentType,
      disposition: disposition || null,
      content_id: contentId,
      inline,
      attachment: isAttachment || Boolean(name) || type === 'message/rfc822',
      external: type === 'message/external-body',
      get size() {
        return (bytes ??= leafBytes(body, encoding)).byteLength;
      },
      bytes: () => (bytes ??= leafBytes(body, encoding)),
      headers: h,
    };
    const r = visit(part);
    return r == null ? text : r;
  };
  return walk(String(raw || ''), 0);
}

/**
 * The parts of an email that are files: [{ index, name, type, size, inline, bytes() }] (attachments, attached
 * messages, and inline images). Text and HTML bodies are not. `raw` is the message as a binary string.
 */
export function emailFileParts(raw) {
  const out = [];
  rewriteMime(raw, (p) => {
    if (p.attachment && !p.external) out.push({ index: p.index, name: p.name || (p.type === 'message/rfc822' ? 'message.eml' : 'attachment'), type: p.type, size: p.size, inline: p.inline, bytes: p.bytes });
    return null;
  });
  return out;
}

/** Should this file part leave the email for a file of its own? Everything but small inline images. */
export const detachable = (part) => !(part.inline && /^image\//.test(part.type) && part.size < INLINE_KEEP_BYTES);

const headerParam = (v) => (/^[\x20-\x7e]*$/.test(v) ? `"${String(v).replace(/["\\]/g, '\\$&')}"` : null);

/**
 * A copy of an email (binary string) with some of its parts kept elsewhere: `placed` maps a part's index to
 * { path, sha256? }. Each is replaced by a message/external-body part (RFC 2046 5.2.3, access-type local-file)
 * naming the file, keeping its original Content-Type, Content-Disposition and Content-ID, so a mail client still
 * lists it and a reader knows where it went. Headers and bodies are kept byte for byte.
 */
export function detachParts(raw, placed) {
  return rewriteMime(raw, (p) => {
    const at = placed.get(p.index);
    if (!at) return null;
    const name = headerParam(at.path);
    const nameParam = name ? `name=${name}` : `name*=utf-8''${encodeURIComponent(at.path)}`;
    const lines = [
      `Content-Type: message/external-body; access-type=local-file; ${nameParam}`,
      ...(p.disposition ? [`Content-Disposition: ${p.disposition}`] : []),
      `X-Folio-Detached: size=${p.size}${at.sha256 ? `; sha256=${at.sha256}` : ''}`,
      '',
      `Content-Type: ${p.content_type}`,
      ...(p.content_id ? [`Content-ID: ${p.content_id}`] : []),
      '',
      '',
    ];
    return lines.join('\r\n');
  });
}

/** The files an email points at after detachParts: [{ name, type, path, size }]. */
export function detachedFiles(raw) {
  const out = [];
  rewriteMime(raw, (p) => {
    if (!p.external) return null;
    const path = decodeEncodedWords(param(p.content_type, 'name')) || (() => {
      const m = /name\*=utf-8''([^;\s]+)/i.exec(p.content_type);
      return m ? decodeURIComponent(m[1]) : null;
    })();
    // The body of an external-body part is the headers of the part it stands for.
    const innerType = /content-type:\s*([^;\r\n]+)/i.exec(binaryString(p.bytes()))?.[1]?.trim().toLowerCase() || null;
    const size = Number(/size=(\d+)/.exec(p.headers['x-folio-detached'] || '')?.[1]) || null;
    out.push({ name: p.name || (path ? path.split('/').pop() : 'attachment'), type: innerType, path, size });
    return null;
  });
  return out;
}

// ---- writing a message from its fields (for tools that give an email's fields, not its bytes) ----

const fold = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();
const needsEncoding = (s) => /[^\x20-\x7e]/.test(s);
const encodeWord = (s) => (needsEncoding(s) ? `=?UTF-8?B?${btoa(binaryString(new TextEncoder().encode(s)))}?=` : s);
const base64Lines = (bytes) => btoa(binaryString(bytes)).replace(/.{1,76}/g, '$&\r\n');
const listOf = (v) => (Array.isArray(v) ? v.filter(Boolean).map(fold).join(', ') : fold(v));

/** An address list with non-ASCII display names encoded (RFC 2047); addresses themselves are kept. */
function encodeAddresses(v) {
  return listOf(v)
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((one) => {
      const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(one);
      if (!m || !needsEncoding(m[1])) return one.trim();
      return `${encodeWord(m[1].trim())} <${m[2].trim()}>`;
    })
    .filter(Boolean)
    .join(', ');
}

/**
 * Write an RFC 5322 message from an email's fields: { from, to?, cc?, date?, subject?, message_id?, in_reply_to?,
 * references?, text?, html?, attachments?: [{ name, type?, bytes }] }. For agents and tools that read mail as
 * fields (a mail API, an MCP server) rather than as the message itself. Returns the message as bytes.
 */
export function buildEmail(fields = {}) {
  const from = fold(fields.from);
  if (!from) throw new Error('An email needs a From address');
  const text = fields.text == null ? null : String(fields.text);
  const html = fields.html == null ? null : String(fields.html);
  if (!text && !html) throw new Error('An email needs its text (or HTML)');
  const date = fields.date && !Number.isNaN(Date.parse(fields.date)) ? new Date(fields.date).toUTCString().replace('GMT', '+0000') : null;
  const id = (v) => (v ? (/^<.*>$/.test(fold(v)) ? fold(v) : `<${fold(v)}>`) : null);
  const head = [
    `From: ${encodeAddresses(from)}`,
    fields.to && `To: ${encodeAddresses(fields.to)}`,
    fields.cc && `Cc: ${encodeAddresses(fields.cc)}`,
    `Subject: ${encodeWord(fold(fields.subject || ''))}`,
    date && `Date: ${date}`,
    fields.message_id && `Message-ID: ${id(fields.message_id)}`,
    fields.in_reply_to && `In-Reply-To: ${id(fields.in_reply_to)}`,
    fields.references && `References: ${listOf(fields.references)}`,
    'MIME-Version: 1.0',
  ].filter(Boolean);
  const boundary = (tag) => `=_folio_${tag}_${Math.random().toString(36).slice(2, 12)}`;
  const leaf = (type, body) => `Content-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Lines(new TextEncoder().encode(body))}`;
  let body;
  if (text && html) {
    const b = boundary('alt');
    body = `Content-Type: multipart/alternative; boundary="${b}"\r\n\r\n--${b}\r\n${leaf('text/plain', text)}--${b}\r\n${leaf('text/html', html)}--${b}--\r\n`;
  } else body = leaf(text ? 'text/plain' : 'text/html', text ?? html);
  const files = (fields.attachments || []).filter((a) => a && a.bytes);
  if (files.length) {
    const b = boundary('mixed');
    const parts = files.map((a) => {
      const name = fold(a.name || 'attachment');
      const n = needsEncoding(name) ? `filename*=utf-8''${encodeURIComponent(name)}` : `filename="${name.replace(/["\\]/g, '\\$&')}"`;
      return `--${b}\r\nContent-Type: ${fold(a.type) || 'application/octet-stream'}\r\nContent-Disposition: attachment; ${n}\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Lines(a.bytes)}`;
    });
    body = `Content-Type: multipart/mixed; boundary="${b}"\r\n\r\n--${b}\r\n${body}${parts.join('')}--${b}--\r\n`;
  }
  return new TextEncoder().encode(`${head.join('\r\n')}\r\n${body}`);
}
