import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Folio, MemoryFs, ValidationError, isDraftPath } from '../src/index.js';

let clock = 0;
const now = () => new Date(Date.UTC(2026, 10, 12, 15, 0, clock++)).toISOString();
const staff = { type: 'user', id: 'chris@engine9.ai' };
const agent = { type: 'agent', id: 'agent:cursor', on_behalf_of: 'chris@engine9.ai' };
const team = (channel, address) => channel === 'email' && /@engine9\.ai$/.test(address);

const make = async () => {
  const folio = await Folio.init(new MemoryFs(), { title: 'Pipeline', now, actor: staff });
  await folio.addCc('Tim Thornburg <tim@acme.org>', { actor: staff });
  return folio;
};

const email = (lines) => lines.join('\r\n');

test('an agent drafts a client message; nothing is sent until a person sends the draft', async () => {
  const folio = await make();
  await folio.receive({ channel: 'email', address: 'tim@acme.org' }, 'Where are we?');
  const d = await folio.draftClientMessage('Hi Tim, six questions: ...', { actor: agent });
  assert.ok(isDraftPath(d.path));
  assert.equal(d.draft.to, 'client');
  // Not in the conversation, not seen by the client, the client still waits.
  assert.equal((await folio.comms({ team })).some((m) => m.path === d.path), false);
  assert.equal((await folio.clientComms({ team })).length, 1);
  assert.equal((await folio.clientThread({ team })).waiting, 'us');
  const drafts = await folio.drafts();
  assert.equal(drafts.length, 1);
  await folio.editDraft(d.path, { text: 'Hi Tim, five questions: ...', actor: staff });
  const sent = await folio.sendDraft(d.path, { actor: staff });
  assert.deepEqual(sent.message.to, ['email:tim@acme.org']);
  assert.equal(sent.message.text, 'Hi Tim, five questions: ...');
  assert.equal(sent.message.drafted.by.id, 'agent:cursor');
  assert.equal(sent.message.author.id, 'chris@engine9.ai');
  assert.deepEqual(await folio.drafts(), []);
  assert.equal((await folio.clientThread({ team })).waiting, 'client');
  const item = (await folio.comms({ team })).find((m) => m.path === sent.path);
  assert.equal(item.drafted.by.id, 'agent:cursor');
});

test('a draft can be discarded, and sending needs someone on the client list', async () => {
  const folio = await Folio.init(new MemoryFs(), { title: 'No CCs', now, actor: staff });
  const d = await folio.draftClientMessage('Hello', { actor: agent });
  await assert.rejects(folio.sendDraft(d.path, { actor: staff }), ValidationError);
  assert.equal((await folio.drafts()).length, 1);
  await folio.discardDraft(d.path);
  assert.deepEqual(await folio.drafts(), []);
  await assert.rejects(folio.draftClientMessage('  ', { actor: agent }), ValidationError);
});

test('replied outside Folio: a required note stops the wait and stays with the team', async () => {
  const folio = await make();
  await folio.receive({ channel: 'email', address: 'tim@acme.org' }, 'Can you call me?');
  await assert.rejects(folio.markRepliedOutside('', { actor: staff }), ValidationError);
  await assert.rejects(folio.markRepliedOutside('called', { actor: staff }), ValidationError);
  await assert.rejects(folio.markRepliedOutside('Called Tim, agreed on Friday.', { actor: staff, at: '2030-01-01' }), ValidationError);
  const r = await folio.markRepliedOutside('Called Tim on his cell; agreed to test Friday with the October file.', { actor: staff });
  assert.equal(r.message.replied_outside, true);
  const t = await folio.clientThread({ team });
  assert.equal(t.waiting, 'client');
  assert.equal(t.sent, 0);
  assert.equal(t.answered_outside, 1);
  assert.match(t.last_outside.note, /Friday/);
  // The client never sees the note.
  assert.equal((await folio.clientComms({ team })).some((m) => /Friday/.test(m.text)), false);
});

test('an email from the team to the client, copied to the folio, counts as a reply; a forward still opens the thread', async () => {
  const folio = await make();
  await folio.add({ text: email(['From: Chris Lundberg <chris@engine9.ai>', 'To: folio+fol-x@engine9.ai', 'Subject: Fwd: Pipeline docs', 'Date: Wed, 11 Nov 2026 01:53:30 +0000', 'Message-ID: <a@x>', '', 'Begin forwarded message:', '', 'From: Tim Thornburg <tim@acme.org>', 'Subject: Pipeline docs', 'Date: October 29, 2026', '', 'Attached are the docs.', '']), as: 'auto' }, { actor: staff });
  assert.equal((await folio.clientThread({ team })).waiting, 'us');
  await folio.add({ text: email(['From: Chris Lundberg <chris@engine9.ai>', 'To: Tim Thornburg <tim@acme.org>', 'Cc: folio+fol-x@engine9.ai', 'Subject: Re: Pipeline docs', 'Date: Thu, 12 Nov 2026 10:00:00 +0000', 'Message-ID: <b@x>', '', 'Thanks Tim, testing this week.', '', '-----Original Message-----', 'From: Tim Thornburg <tim@acme.org>', 'Subject: Pipeline docs', '', 'Attached are the docs.', '']), as: 'auto' }, { actor: staff });
  const items = await folio.comms({ team });
  const reply = items.find((m) => /Re: Pipeline/.test(m.subject || ''));
  assert.equal(reply.thread, 'client');
  assert.equal(reply.direction, 'out');
  const t = await folio.clientThread({ team });
  assert.equal(t.waiting, 'client');
  assert.equal(t.first_reply, '2026-11-12T10:00:00.000Z');
  const seen = (await folio.clientComms({ team })).find((m) => m.direction === 'out');
  assert.equal(seen.from, 'Chris Lundberg');
});
