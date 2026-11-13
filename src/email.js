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
