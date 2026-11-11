import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Folio, MemoryFs, NotFoundError, ValidationError, ccKey, findCc, parseCc, validateFolio } from '../src/index.js';

const now = () => '2026-11-09T15:00:00.000Z';
const actor = { type: 'user', id: 'chris@frakture.com' };
const make = async () => {
  const fs = new MemoryFs();
  const folio = await Folio.init(fs, { title: 'FBCENC Missing Gifts', now, actor });
  return { fs, folio };
};

test('parseCc reads emails, Slack channels and people, phone numbers and other channels', () => {
  assert.deepEqual(parseCc('Tim Thornburg <Tim@Pursuant.com>'), { name: 'Tim Thornburg', channel: 'email', address: 'tim@pursuant.com', kind: 'person', audience: 'client' });
  assert.deepEqual(parseCc('mailto:joe@pursuant.com'), { channel: 'email', address: 'joe@pursuant.com', kind: 'person', audience: 'client' });
  assert.deepEqual(parseCc('#Acme-Support'), { channel: 'slack', address: '#acme-support', kind: 'channel', audience: 'client' });
  assert.deepEqual(parseCc('slack:C0123ABCD'), { channel: 'slack', address: 'C0123ABCD', kind: 'channel', audience: 'client' });
  assert.deepEqual(parseCc('@tim'), { channel: 'slack', address: '@tim', kind: 'person', audience: 'client' });
  assert.deepEqual(parseCc('U0456EFGH', { workspace: 'engine9' }), { channel: 'slack', address: 'U0456EFGH', kind: 'person', workspace: 'engine9', audience: 'client' });
  assert.deepEqual(parseCc('+1 (202) 555-0142'), { channel: 'sms', address: '+12025550142', kind: 'person', audience: 'client' });
  assert.deepEqual(parseCc('tel:+12025550142'), { channel: 'sms', address: '+12025550142', kind: 'person', audience: 'client' });
  assert.deepEqual(parseCc('teams:Support Channel', { kind: 'channel' }), { channel: 'teams', address: 'Support Channel', kind: 'channel', audience: 'client' });
  assert.throws(() => parseCc('not an address'), ValidationError);
  assert.throws(() => parseCc(''), ValidationError);
  assert.throws(() => parseCc('x', { channel: 'email' }), ValidationError);
  assert.deepEqual(parseCc('fbcenc', { channel: 'slack' }), { channel: 'slack', address: 'fbcenc', kind: 'person', audience: 'client' });
  assert.deepEqual(parseCc('#fbcenc', { channel: 'slack' }), { channel: 'slack', address: '#fbcenc', kind: 'channel', audience: 'client' });
  assert.deepEqual(parseCc('202 555 0142', { channel: 'sms' }), { channel: 'sms', address: '2025550142', kind: 'person', audience: 'client' });
});

test('a folio keeps its own CC list in folio.json; adding twice does not duplicate, and every change is recorded', async () => {
  const { fs, folio } = await make();
  const a = await folio.addCc('Tim Thornburg <tim@pursuant.com>', { actor });
  assert.equal(a.added, true);
  assert.equal(a.entry.added_by, 'chris@frakture.com');
  await folio.addCc('#fbcenc', { actor, workspace: 'pursuant' });
  await folio.addCc({ channel: 'sms', address: '+12025550142', name: 'Joe McLaughlin' }, { actor });
  const again = await folio.addCc('TIM@pursuant.com', { actor });
  assert.equal(again.added, false);
  const renamed = await folio.addCc('Timothy Thornburg <tim@pursuant.com>', { actor });
  assert.equal(renamed.entry.name, 'Timothy Thornburg');

  const m = JSON.parse((await fs.read('folio.json')).text);
  assert.deepEqual(m.cc.map(ccKey), ['email:tim@pursuant.com', 'slack@pursuant:#fbcenc', 'sms:+12025550142']);
  const list = await folio.ccs();
  assert.ok(list.every((c) => c.integration_state === 'reference_only' && c.key));
  assert.equal((await folio.overview()).cc.length, 3);
  assert.ok((await folio.history()).some((h) => h.changes.cc));
  assert.equal((await validateFolio(fs)).ok, true);

  await folio.removeCc('slack@pursuant:#fbcenc', { actor });
  await folio.removeCc('+1 202 555 0142', { actor });
  assert.deepEqual((await folio.ccs()).map((c) => c.key), ['email:tim@pursuant.com']);
  await assert.rejects(folio.removeCc('nobody@example.com'), NotFoundError);
});

test('a message from a CC is credited to that person or channel, and a second delivery is ignored', async () => {
  const { folio } = await make();
  await folio.addCc('#fbcenc', { actor, workspace: 'pursuant', name: 'FBCENC channel' });
  const seen = [];
  folio.onMessage = async (m) => seen.push(m);

  const r = await folio.receive({ channel: 'slack', address: '#FBCENC', workspace: 'pursuant' }, 'Report attached in the thread.', { ref: '1731170000.0001', at: '2026-11-09T16:00:00.000Z' });
  assert.equal(r.cc, 'slack@pursuant:#fbcenc');
  assert.deepEqual(r.message.author, { type: 'channel', channel: 'slack', id: '#fbcenc', name: 'FBCENC channel', workspace: 'pursuant' });
  assert.equal(r.message.via, 'channel/slack');
  const dup = await folio.receive({ channel: 'slack', address: '#fbcenc' }, 'Report attached in the thread.', { ref: '1731170000.0001' });
  assert.equal(dup.duplicate, true);
  assert.equal(dup.path, r.path);
  assert.equal(seen.length, 1, 'hosts hear of each new message once');

  // Someone not CC'd cannot post this way, nor a CC from another workspace.
  await assert.rejects(folio.receive({ channel: 'slack', address: '#random' }, 'hi'), NotFoundError);
  await assert.rejects(folio.receive({ channel: 'slack', address: '#fbcenc', workspace: 'other' }, 'hi'), NotFoundError);

  const said = await folio.comms();
  assert.equal(said.length, 1);
  assert.equal(said[0].cc, 'slack@pursuant:#fbcenc');
});

test('comments and emails from CC’d addresses are marked in the conversation; hosts hear of new emails', async () => {
  const { folio } = await make();
  await folio.addCc('Tim Thornburg <tim@pursuant.com>', { actor });
  const seen = [];
  folio.onMessage = async (m) => seen.push(m);
  await folio.comment('Pulled it from RE, need more info.', { actor });
  const eml = 'From: Tim Thornburg <tim@pursuant.com>\r\nTo: support@frakture.com\r\nSubject: FBCENC Missing Gifts\r\nDate: Thu, 05 Nov 2026 19:38:00 +0000\r\nMessage-ID: <abc@pursuant.com>\r\n\r\nApologies for the back and forth. Report in the morning.\r\n';
  await folio.add({ name: 'reply.eml', type: 'message/rfc822', data: eml }, { actor });
  await folio.add({ name: 'reply.eml', type: 'message/rfc822', data: eml }, { actor }); // same message again
  assert.deepEqual(seen.map((m) => m.kind), ['comment', 'email']);
  assert.equal(seen[1].author.id, 'tim@pursuant.com');
  assert.match(seen[1].text, /Report in the morning/);
  const said = await folio.comms();
  const email = said.find((m) => m.kind === 'email');
  assert.equal(email.cc, 'email:tim@pursuant.com');
  assert.equal(email.author.name, 'Tim Thornburg');
  assert.equal(said.find((m) => m.kind === 'comment').cc, undefined);
});

test('imported history is not passed on to CCs', async () => {
  const { folio } = await make();
  const seen = [];
  folio.onMessage = async (m) => seen.push(m);
  await folio.post('comment', 'From Asana', { actor });
  assert.equal(seen.length, 1);
  const { postMessage } = await import('../src/comms.js');
  await postMessage(folio, { kind: 'comment', text: 'old', actor, imported: { source: 'asana' } });
  assert.equal(seen.length, 1);
});

test('validation reports a malformed or duplicated CC list', async () => {
  const fs = new MemoryFs();
  await Folio.init(fs, { title: 'x', now });
  const m = JSON.parse((await fs.read('folio.json')).text);
  m.cc = [{ channel: 'email', address: 'a@b.co' }, { channel: 'email', address: 'A@b.co' }, { address: 'x' }];
  await fs.write('folio.json', JSON.stringify(m));
  const r = await validateFolio(fs);
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems.filter((p) => p.code.startsWith('cc_')).map((p) => p.code).sort(), ['cc_duplicate', 'cc_shape']);
  assert.equal(findCc(m.cc, { type: 'email', channel: 'email', id: 'a@b.co' }).address, 'a@b.co');
});

test('CCs are on the team or the client list; client is the default and entries move between them', async () => {
  const { fs, folio } = await make();
  await folio.addCc('Tim Thornburg <tim@pursuant.com>', { actor });
  await folio.addCc('#fbcenc-staff', { actor, audience: 'team' });
  assert.deepEqual((await folio.ccs()).map((c) => [c.key, c.audience]), [['email:tim@pursuant.com', 'client'], ['slack:#fbcenc-staff', 'team']]);
  // Re-adding without an audience keeps the one it has; asking for one moves it.
  await folio.addCc('#fbcenc-staff', { actor });
  assert.equal((await folio.ccs())[1].audience, 'team');
  await folio.addCc('tim@pursuant.com', { actor, audience: 'team' });
  assert.equal((await folio.ccs())[0].audience, 'team');
  await folio.setCcAudience('email:tim@pursuant.com', 'client', { actor });
  await folio.setCcAudience('#FBCENC-staff', 'team', { actor });
  assert.deepEqual((await folio.ccs()).map((c) => c.audience), ['client', 'team']);
  await assert.rejects(folio.setCcAudience('email:tim@pursuant.com', 'everyone'), ValidationError);
  await assert.rejects(folio.setCcAudience('nobody@x.com', 'team'), NotFoundError);
  assert.throws(() => parseCc('a@b.co', { audience: 'boss' }), ValidationError);
  assert.equal((await validateFolio(fs)).ok, true);
});

test('messages are for the team unless sent to chosen client contacts, and record exactly who they went to', async () => {
  const { folio } = await make();
  await folio.addCc('Tim Thornburg <tim@pursuant.com>', { actor });
  await folio.addCc('Joe <joe@pursuant.com>', { actor });
  await folio.addCc('#staff', { actor, audience: 'team' });
  const seen = [];
  folio.onMessage = async (m) => seen.push(m);
  await folio.comment('Team only: they are on the old feed.', { actor });
  await folio.comment('Hi both, we are on it.', { actor, to: 'client' });
  await folio.comment('Tim, report attached.', { actor, to: ['tim@pursuant.com'] });
  assert.deepEqual(seen.map((m) => m.to || null), [null, ['email:tim@pursuant.com', 'email:joe@pursuant.com'], ['email:tim@pursuant.com']]);
  await assert.rejects(folio.comment('x', { actor, to: ['slack:#staff'] }), /team list/);
  await assert.rejects(folio.comment('x', { actor, to: ['zed@x.com'] }), /not a client contact/);
  await assert.rejects(folio.comment('x', { actor, to: [] }), ValidationError);
  const said = await folio.comms();
  const by = Object.fromEntries(said.map((m) => [m.text.split(' ')[0], m]));
  assert.deepEqual([by['Team'].thread, by['Team'].direction], ['team', undefined]);
  assert.deepEqual([by['Hi'].thread, by['Hi'].direction], ['client', 'out']);
  assert.deepEqual(by['Tim,'].to, ['email:tim@pursuant.com']);
});

test('the client thread interleaves with the team’s and keeps its own timing', async () => {
  const fs = new MemoryFs();
  let t = '2026-11-09T09:00:00.000Z';
  const folio = await Folio.init(fs, { title: 'Donate button broken', now: () => t, actor });
  await folio.addCc('Tim Thornburg <tim@pursuant.com>', { actor });
  await folio.addCc('#staff', { actor, audience: 'team' });
  const eml = (h, body) => `From: Tim Thornburg <tim@pursuant.com>\r\nTo: support@frakture.com\r\nSubject: Donate button broken\r\nDate: ${h}\r\nMessage-ID: <${body.length}@p.com>\r\n\r\n${body}\r\n`;
  await folio.add({ name: 'a.eml', type: 'message/rfc822', data: eml('Mon, 09 Nov 2026 09:00:00 +0000', 'The donate button is broken.') }, { actor });
  assert.deepEqual(await folio.clientThread(), { waiting: 'us', since: '2026-11-09T09:00:00.000Z', first_in: '2026-11-09T09:00:00.000Z', first_reply: null, last_in: '2026-11-09T09:00:00.000Z', last_out: null, unanswered: 1, sent: 0, received: 1 });
  t = '2026-11-09T09:05:00.000Z';
  await folio.comment('Got it, looking now.', { actor, to: 'client' });
  t = '2026-11-09T10:00:00.000Z';
  await folio.comment('Regex lookbehind again?', { actor });
  await folio.receive({ channel: 'slack', address: '#staff' }, 'Yes, Safari.', { at: '2026-11-09T10:10:00.000Z' });
  await folio.add({ name: 'b.eml', type: 'message/rfc822', data: eml('Mon, 09 Nov 2026 11:00:00 +0000', 'Any news? Still broken.') }, { actor });
  const said = await folio.comms();
  assert.deepEqual(said.map((m) => `${m.thread}${m.direction ? `/${m.direction}` : ''}`), ['client/in', 'client/out', 'team', 'team', 'client/in']);
  const ct = await folio.clientThread();
  assert.equal(ct.waiting, 'us');
  assert.equal(ct.since, '2026-11-09T11:00:00.000Z');
  assert.equal(ct.first_reply, '2026-11-09T09:05:00.000Z');
  t = '2026-11-09T12:00:00.000Z';
  await folio.comment('Fixed: the regex is gone. Summary: …', { actor, to: 'client' });
  const done = await folio.clientThread();
  assert.deepEqual([done.waiting, done.since, done.sent, done.received, done.unanswered], ['client', '2026-11-09T12:00:00.000Z', 2, 2, 0]);

  // An email from someone on the team is not the client talking.
  const staff = 'From: Pat <pat@frakture.com>\r\nTo: support@frakture.com\r\nSubject: fyi\r\nDate: Mon, 09 Nov 2026 13:00:00 +0000\r\nMessage-ID: <s@f.com>\r\n\r\nInternal fyi\r\n';
  await folio.add({ name: 'c.eml', type: 'message/rfc822', data: staff }, { actor });
  const isTeam = (channel, address) => channel === 'email' && address.endsWith('@frakture.com');
  assert.equal((await folio.comms({ team: isTeam })).pop().thread, 'team');
  assert.equal((await folio.clientThread({ team: isTeam })).waiting, 'client');
  assert.equal((await folio.clientThread()).waiting, 'us', 'without the team rule, an unknown sender counts as the client');
});

test('a folio with no client conversation has no client thread', async () => {
  const { folio } = await make();
  await folio.comment('Just us.', { actor });
  assert.equal(await folio.clientThread(), null);
});
