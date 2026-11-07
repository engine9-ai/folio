import { redactText, scanText } from '@engine9/pii-classifier';

/**
 * What a folio must never hold, and the one scrub applied to everything that comes in (GUIDE.md, SPEC 3.7).
 *
 *  - Payment cards, bank account numbers (IBAN) and US Social Security numbers: never, in any file. Found by
 *    @engine9/pii-classifier; known test values (Stripe's 4242 4242 4242 4242, 555 phone numbers) are left alone.
 *  - Passwords, tokens, keys and other credentials: never. Point to the password manager entry instead.
 *
 * Client and account contact details (the people the team works with: names, emails and phones in
 * correspondence) are expected in a folio and are not scrubbed. Personal data about the client's members,
 * customers or donors arrives in data files and logs, which are summarised instead of stored (data.js).
 */

export const PROHIBITED_TYPES = Object.freeze(['PAYMENT_CARD', 'IBAN', 'US_SSN']);

/** [name, pattern]. A pattern's group 1, when present, is the secret value itself; otherwise the whole match. */
export const CREDENTIAL_PATTERNS = Object.freeze([
  ['github_token', /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g],
  ['private_key', /(-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----|$))/g],
  ['aws_access_key', /\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/g],
  ['slack_token', /\b(xox[abprs]-[A-Za-z0-9-]{10,})\b/g],
  ['stripe_secret_key', /\b((?:sk|rk)_live_[A-Za-z0-9]{16,})\b/g],
  ['bearer_token', /\bBearer\s+([A-Za-z0-9._~+/=-]{24,})/g],
  ['url_credentials', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:([^\s/@]+)@/gi],
  ['password', /\b(?:password|passwd|pwd|passcode|app[_ -]?password)\b["']?\s*[:=]\s*["']?([^\s"',;]{4,})/gi],
  ['api_key_assignment', /\b(?:api[_-]?key|secret(?:[_-]?key)?|access[_-]?token|auth[_-]?token|client[_-]?secret|token)\b["']?\s*[:=]\s*["']?([A-Za-z0-9._~+/=-]{16,})["']?/gi],
]);

const CREDENTIAL_MARK = '[removed: credential; keep it in the password manager]';

/** Values that are obviously not secrets: placeholders and references to a password manager. */
const NOT_A_SECRET = /^(?:\*+|x{3,}|\.{3,}|<[^>]*>|\$\{?[A-Z_][A-Z0-9_]*\}?|\{\{[^}]*\}\}|redacted|changeme|example|placeholder|none|null|n\/a|see\b.*|in\b.*|op:\/\/.*|1password.*|bitwarden.*|lastpass.*|vault.*|keychain.*|\[removed.*)$/i;

/** Credentials in text: [{ name, start, end }] covering the secret value. */
export function findCredentials(text) {
  const s = String(text ?? '');
  const out = [];
  for (const [name, source] of CREDENTIAL_PATTERNS) {
    const re = new RegExp(source.source, source.flags);
    let m;
    while ((m = re.exec(s))) {
      const value = m[1] ?? m[0];
      if (m.index === re.lastIndex) re.lastIndex += 1;
      if (!value || NOT_A_SECRET.test(value)) continue;
      const start = m.index + m[0].indexOf(value);
      out.push({ name, start, end: start + value.length });
    }
  }
  out.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const c of out) {
    const last = merged.at(-1);
    if (last && c.start < last.end) last.end = Math.max(last.end, c.end);
    else merged.push({ ...c });
  }
  return merged;
}

/**
 * Remove what a folio must never hold from free text: credentials, and card, bank and SSN numbers.
 * Returns { text, removed: { PAYMENT_CARD: 1, CREDENTIAL: 2, ... }, total }. Unchanged text comes back as is.
 */
export function scrubText(text) {
  const source = String(text ?? '');
  const removed = {};
  let total = 0;
  const creds = findCredentials(source);
  let out = source;
  if (creds.length) {
    let next = '';
    let at = 0;
    for (const c of creds) {
      next += out.slice(at, c.start) + CREDENTIAL_MARK;
      at = c.end;
    }
    out = next + out.slice(at);
    removed.CREDENTIAL = creds.length;
    total += creds.length;
  }
  if (/\d/.test(out)) {
    const r = redactText(out, { types: PROHIBITED_TYPES, maxChars: Math.max(out.length, 1) });
    if (r.total) {
      out = r.text;
      for (const [k, v] of Object.entries(r.redacted)) removed[k] = v;
      total += r.total;
    }
  }
  return { text: total ? out : source, removed, total };
}

/** What scrubText would remove, without changing anything: { PAYMENT_CARD: 1, CREDENTIAL: 1 }. */
export function prohibitedIn(text) {
  const source = String(text ?? '');
  const found = {};
  const creds = findCredentials(source).length;
  if (creds) found.CREDENTIAL = creds;
  if (/\d/.test(source)) {
    const scan = scanText(source, { types: PROHIBITED_TYPES, maxChars: Math.max(source.length, 1) });
    for (const span of scan.spans) if (!span.synthetic) found[span.type] = (found[span.type] || 0) + 1;
  }
  return found;
}

/** "2 card numbers and 1 credential" */
export function describeRemoved(removed = {}) {
  const words = { PAYMENT_CARD: ['card number', 'card numbers'], IBAN: ['bank account number', 'bank account numbers'], US_SSN: ['Social Security number', 'Social Security numbers'], CREDENTIAL: ['credential', 'credentials'] };
  const parts = Object.entries(removed)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${(words[k] || [k.toLowerCase(), k.toLowerCase()])[n === 1 ? 0 : 1]}`);
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}
