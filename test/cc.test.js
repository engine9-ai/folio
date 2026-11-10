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
  assert.deepEqual(parseCc('Tim Thornburg <Tim@Pursuant.com>'), { name: 'Tim Thornburg', channel: 'email', address: 'tim@pursuant.com', kind: 'person' });
  assert.deepEqual(parseCc('mailto:joe@pursuant.com'), { channel: 'email', address: 'joe@pursuant.com', kind: 'person' });
  assert.deepEqual(parseCc('#Acme-Support'), { channel: 'slack', address: '#acme-support', kind: 'channel' });
  assert.deepEqual(parseCc('slack:C0123ABCD'), { channel: 'slack', address: 'C0123ABCD', kind: 'channel' });
  assert.deepEqual(parseCc('@tim'), { channel: 'slack', address: '@tim', kind: 'person' });
  assert.deepEqual(parseCc('U0456EFGH', { workspace: 'engine9' }), { channel: 'slack', address: 'U0456EFGH', kind: 'person', workspace: 'engine9' });
  assert.deepEqual(parseCc('+1 (202) 555-0142'), { channel: 'sms', address: '+12025550142', kind: 'person' });
  assert.deepEqual(parseCc('tel:+12025550142'), { channel: 'sms', address: '+12025550142', kind: 'person' });
  assert.deepEqual(parseCc('teams:Support Channel', { kind: 'channel' }), { channel: 'teams', address: 'Support Channel', kind: 'channel' });
  assert.throws(() => parseCc('not an address'), ValidationError);
  assert.throws(() => parseCc(''), ValidationError);
  assert.throws(() => parseCc('x', { channel: 'email' }), ValidationError);
  assert.deepEqual(parseCc('fbcenc', { channel: 'slack' }), { channel: 'slack', address: 'fbcenc', kind: 'person' });
  assert.deepEqual(parseCc('#fbcenc', { channel: 'slack' }), { channel: 'slack', address: '#fbcenc', kind: 'channel' });
  assert.deepEqual(parseCc('202 555 0142', { channel: 'sms' }), { channel: 'sms', address: '2025550142', kind: 'person' });
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

test('internal notes are stored as such and are not news for CCs', async () => {
  const { folio } = await make();
  const seen = [];
  folio.onMessage = async (m) => seen.push(m);
  await folio.comment('Team only: they are on the old feed.', { actor, internal: true });
  await folio.comment('Hi Tim, report attached.', { actor });
  assert.deepEqual(seen.map((m) => m.internal === true), [true, false]);
  const said = await folio.comms({ cc: [] });
  assert.equal(said.find((m) => m.text.startsWith('Team only')).internal, true);
  assert.equal(said.find((m) => m.text.startsWith('Hi Tim')).internal, undefined);
});
