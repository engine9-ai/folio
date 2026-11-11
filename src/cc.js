import { ValidationError } from './errors.js';
import { emailAddress } from './email.js';

/**
 * CC: the people and channels kept informed about a folio (spec 5.7). Like the CC line of a help-desk case, but
 * not tied to email: a CC can be an email address, a Slack channel or person, a phone number for SMS, or any other
 * channel a deployment knows how to reach. The list is per folio and lives in folio.json `cc`:
 *
 *   "cc": [
 *     { "channel": "email", "address": "tim@pursuant.com", "name": "Tim Thornburg", "kind": "person", "audience": "client", "added_at", "added_by" },
 *     { "channel": "slack", "address": "#acme-support", "workspace": "engine9", "kind": "channel", "audience": "team" },
 *     { "channel": "sms",   "address": "+12025550142", "name": "Joe McLaughlin", "kind": "person", "audience": "client" }
 *   ]
 *
 * Every entry is in one of two buckets, its `audience`:
 *   team    staff and closely integrated partners: they hear everything said in the folio, internal notes included.
 *   client  the client and other outside contacts: they hear only messages deliberately sent to them (a message's
 *           `to`, comms.js), and what they send back forms the folio's client thread, whose timing matters.
 * An entry without an audience is a client: the safe side, since telling a client something by accident is worse
 * than a teammate missing a note.
 *
 * The list is a reference, like a repository listing (3.2.1): nothing in the library sends anything. Delivering a
 * message to a CC is an optional add-on of each hosting deployment, configured there and never in the folio, so a
 * copied folio keeps its CC list without gaining the ability to message anyone. Hosts report each entry's live
 * state ("delivered" or "listed only"); in the portable library every entry reads as `reference_only`.
 *
 * A message that comes back from a CC (a Slack reply, an SMS, an email from a CC'd address) is credited to it: its
 * author is { type: person | channel, channel, id: address, name?, workspace? } and readers mark it with the
 * CC's key (folio.comms()).
 */

/** Channels with built-in parsing. Others are allowed: any lowercase word ("teams", "discord", "whatsapp"). */
export const CC_CHANNELS = Object.freeze(['email', 'slack', 'sms']);
export const CC_KINDS = Object.freeze(['person', 'channel']);
export const CC_AUDIENCES = Object.freeze(['team', 'client']);
export const CC_AUDIENCE_LABELS = Object.freeze({ team: 'Team', client: 'Client' });
/** An entry's bucket: "team" or "client" (the default). */
export const ccAudience = (entry) => (entry?.audience === 'team' ? 'team' : 'client');
export const CC_CHANNEL_LABELS = Object.freeze({ email: 'Email', slack: 'Slack', sms: 'SMS' });
const CHANNEL = /^[a-z][a-z0-9_-]{0,23}$/;
const PHONE = /^\+?[0-9]{7,15}$/;
const SLACK_ID = /^[CGDUW][A-Z0-9]{6,}$/;
export const MAX_CC = 100;

export const ccChannelLabel = (c) => CC_CHANNEL_LABELS[c] || String(c || '').replace(/^./, (x) => x.toUpperCase());

/** The identity of an entry, for matching and removal: "slack:#acme-support", "email:tim@pursuant.com". */
export function ccKey(entry) {
  if (!entry) return '';
  const channel = String(entry.channel || '').toLowerCase();
  let address = String(entry.address ?? entry.id ?? '').trim();
  if (channel === 'email') address = emailAddress(address) || address.toLowerCase();
  else if (channel === 'sms') address = address.replace(/[^\d+]/g, '');
  else address = address.toLowerCase();
  const ws = entry.workspace ? `@${String(entry.workspace).toLowerCase()}` : '';
  return `${channel}${ws}:${address}`;
}

function phone(s) {
  const digits = String(s).replace(/[\s().-]/g, '');
  return PHONE.test(digits) ? digits : null;
}

/**
 * Read a CC from what someone typed or an object, and normalise it. Strings:
 *   tim@pursuant.com, "Tim Thornburg <tim@pursuant.com>", mailto:...   -> email (person)
 *   #acme-support, slack:#acme-support, slack:C0123ABCD                -> slack channel
 *   @tim, slack:@tim, slack:U0123ABCD                                  -> slack person
 *   +1 202 555 0142, sms:+12025550142, tel:...                         -> sms (person)
 *   teams:General, <channel>:<address>                                 -> that channel
 * `channel` (and `name`, `kind`, `workspace`) in `opts` override what was detected.
 */
export function parseCc(input, opts = {}) {
  let o;
  if (input && typeof input === 'object') o = { ...input };
  else {
    let s = String(input ?? '').trim();
    if (!s) throw new ValidationError('A CC needs an address: an email, a Slack channel or person, or a phone number');
    o = {};
    const named = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(s);
    if (named) {
      if (named[1].trim()) o.name = named[1].trim();
      s = named[2].trim();
    }
    const prefixed = /^([a-z][a-z0-9_-]{0,23}):(?!\/\/)(.+)$/i.exec(s);
    if (opts.channel && !prefixed?.[1]?.match(/^(mailto|tel|sms|slack|email)$/i)) {
      // The channel was chosen: take the address as typed (normalizeCc checks it for that channel).
      o.channel = String(opts.channel).toLowerCase();
      o.address = o.channel === 'slack' || /^mailto:/i.test(s) ? s.replace(/^mailto:/i, '') : s;
    } else if (prefixed && !/^mailto$/i.test(prefixed[1]) && !emailAddress(s)) {
      o.channel = prefixed[1].toLowerCase() === 'tel' ? 'sms' : prefixed[1].toLowerCase();
      o.address = prefixed[2].trim();
    } else if (/^mailto:/i.test(s)) {
      o.channel = 'email';
      o.address = s.slice(7).split('?')[0];
    } else if (emailAddress(s)) {
      o.channel = 'email';
      o.address = s;
    } else if (/^[#@]/.test(s)) {
      o.channel = 'slack';
      o.address = s;
    } else if (phone(s)) {
      o.channel = 'sms';
      o.address = s;
    } else if (SLACK_ID.test(s)) {
      o.channel = 'slack';
      o.address = s;
    } else {
      throw new ValidationError(`“${s}” is not an email address, a Slack #channel or @person, or a phone number. Prefix it with its channel (slack:, sms:, teams:…) to be explicit.`);
    }
  }
  for (const k of ['channel', 'name', 'kind', 'workspace', 'audience']) if (opts[k]) o[k] = opts[k];
  return normalizeCc(o);
}

/** Check and tidy one entry. Unknown fields are kept (spec 3.4). */
export function normalizeCc(input, { now } = {}) {
  const e = { ...input };
  e.channel = String(e.channel || '').trim().toLowerCase();
  if (!CHANNEL.test(e.channel)) throw new ValidationError(`A CC's channel is a lowercase word such as ${CC_CHANNELS.join(', ')}`);
  let address = String(e.address ?? '').trim();
  if (!address) throw new ValidationError('A CC needs an address');
  if (e.channel === 'email') {
    const a = emailAddress(address);
    if (!a) throw new ValidationError(`“${address}” is not an email address`);
    address = a;
  } else if (e.channel === 'sms') {
    const p = phone(address);
    if (!p) throw new ValidationError(`“${address}” is not a phone number`);
    address = p;
  } else if (e.channel === 'slack') {
    if (!/^[#@]?[A-Za-z0-9._-]{1,80}$/.test(address)) throw new ValidationError(`“${address}” is not a Slack channel (#name or id) or person (@name or id)`);
    if (/^#/.test(address)) address = address.toLowerCase();
  } else if (address.length > 200 || /[\r\n]/.test(address)) throw new ValidationError('That address is too long');
  e.address = address;
  if (!e.kind) e.kind = e.channel === 'slack' ? (/^#/.test(address) || /^[CG]/.test(address) ? 'channel' : 'person') : 'person';
  if (!CC_KINDS.includes(e.kind)) throw new ValidationError(`A CC's kind is ${CC_KINDS.join(' or ')}`);
  if (e.audience === undefined || e.audience === null || e.audience === '') e.audience = 'client';
  e.audience = String(e.audience).toLowerCase();
  if (!CC_AUDIENCES.includes(e.audience)) throw new ValidationError(`A CC is on the ${CC_AUDIENCES.join(' or the ')} list`);
  for (const k of ['name', 'workspace']) {
    if (e[k] === undefined || e[k] === null || e[k] === '') delete e[k];
    else e[k] = String(e[k]).trim().slice(0, 120);
  }
  if (now && !e.added_at) e.added_at = now;
  return e;
}

/** Problems with folio.json `cc`, for validateManifest. */
export function validateCc(list) {
  const problems = [];
  if (list === undefined) return problems;
  if (!Array.isArray(list)) return [{ level: 'error', code: 'cc_not_array', path: 'folio.json', message: 'cc must be an array' }];
  const seen = new Set();
  list.forEach((c, i) => {
    const path = `folio.json#cc[${i}]`;
    if (!c || typeof c !== 'object' || typeof c.channel !== 'string' || !CHANNEL.test(c.channel) || typeof c.address !== 'string' || !c.address.trim()) {
      problems.push({ level: 'error', code: 'cc_shape', path, message: 'A CC needs channel (a lowercase word) and address' });
      return;
    }
    if (c.kind !== undefined && !CC_KINDS.includes(c.kind)) problems.push({ level: 'error', code: 'cc_kind', path, message: `kind must be ${CC_KINDS.join(' or ')}` });
    if (c.audience !== undefined && !CC_AUDIENCES.includes(c.audience)) problems.push({ level: 'error', code: 'cc_audience', path, message: `audience must be ${CC_AUDIENCES.join(' or ')}` });
    const key = ccKey(c);
    if (seen.has(key)) problems.push({ level: 'warning', code: 'cc_duplicate', path, message: `${c.channel} ${c.address} is CC'd twice` });
    seen.add(key);
  });
  if (list.length > MAX_CC) problems.push({ level: 'warning', code: 'cc_many', path: 'folio.json', message: `More than ${MAX_CC} CCs` });
  return problems;
}

/**
 * Which CC a sender is: { channel, address, workspace? } (or an author { channel, id }) matched against a list.
 * A workspace on either side must agree when both name one.
 */
export function findCc(list, who) {
  if (!who || !Array.isArray(list)) return null;
  const channel = String(who.channel || '').toLowerCase();
  const address = who.address ?? who.id;
  if (!channel || !address) return null;
  const bare = (e) => ccKey({ channel: e.channel, address: e.address ?? e.id });
  const want = bare({ channel, address });
  return list.find((c) => bare(c) === want && (!c.workspace || !who.workspace || String(c.workspace).toLowerCase() === String(who.workspace).toLowerCase())) || null;
}

/** The author of a message that came from a CC: credited to that person or channel. */
export function ccAuthor(entry, extra = {}) {
  return { type: entry.kind || 'person', channel: entry.channel, id: entry.address, ...(entry.name ? { name: entry.name } : {}), ...(entry.workspace ? { workspace: entry.workspace } : {}), ...extra };
}

/** The channel and address an author speaks from, or null: a CC'd author, or an email's sender. */
export function authorChannel(author) {
  if (!author) return null;
  if (author.channel && author.id) return { channel: author.channel, address: author.id, workspace: author.workspace };
  if (author.type === 'email' && author.id) return { channel: 'email', address: emailAddress(author.id) || author.id };
  if (author.type === 'user' && emailAddress(author.id)) return { channel: 'email', address: emailAddress(author.id) };
  return null;
}
