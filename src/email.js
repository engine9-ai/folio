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
