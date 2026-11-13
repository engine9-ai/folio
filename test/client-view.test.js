import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Folio, MemoryFs, ValidationError, cleanEmailText, forwardedFrom, forwardedHeaders } from '../src/index.js';

let clock = 0;
const now = () => new Date(Date.UTC(2026, 10, 9, 15, 0, clock++)).toISOString();
const staff = { type: 'user', id: 'chris@engine9.ai' };
const team = (channel, address) => channel === 'email' && /@engine9\.ai$/.test(address);

const FORWARD = [
  'From: Chris Lundberg <chris@engine9.ai>',
  'To: folio+fol-abcd@engine9.ai',
  'Subject: Fwd: Donation form is slow',
  'Date: Mon, 09 Nov 2026 16:00:00 +0000',
  'Message-ID: <fwd-1@engine9.ai>',
  '',
  '--',
  'Chris Lundberg',
  '',
  '> Begin forwarded message:',
  '> ',
  '> From: Tim Thornburg <tim@acme.org>',
  '> Subject: Donation form is slow',
  '> Date: November 8, 2026 at 4:40:03 PM EST',
  '> To: Chris Lundberg <chris@engine9.ai>',
  '> ',
  '> Our year-end form takes nine seconds on phones.',
  '> Can you look before Monday?',
  '> ',
  '> Tim',
  '> CONFIDENTIALITY NOTICE. This email message is for the sole use of the intended recipient.',
].join('\n');

const make = async () => {
  const folio = await Folio.init(new MemoryFs(), { title: 'Donation form slow', now, actor: staff });
  await folio.addCc('Tim Thornburg <tim@acme.org>', { actor: staff });
  await folio.addCc({ channel: 'email', address: 'sam@engine9.ai', audience: 'team' }, { actor: staff });
  return folio;
};

test('forwardedHeaders and forwardedFrom read the message a forward carries', () => {
  const body = FORWARD.split('\n\n').slice(1).join('\n\n');
  const h = forwardedHeaders(body);
  assert.equal(forwardedFrom(body), 'tim@acme.org');
  assert.match(h.subject, /Donation form is slow/);
  assert.match(h.date, /November 8/);
  assert.equal(forwardedHeaders('Just a note.\n\nThanks'), null);
});

test('cleanEmailText keeps what was written and drops quotes, signatures and legal notices', () => {
  const reply = 'Thanks, that fixed it.\n\nTim\n--\nTim Thornburg\nVP Data\n\nOn Mon, Nov 9, 2026 at 10:00 AM Chris <chris@engine9.ai> wrote:\n> Try now.\n> Chris';
  const r = cleanEmailText(reply);
  assert.equal(r.text, 'Thanks, that fixed it.\n\nTim');
  assert.equal(r.trimmed, true);
  // A forward whose sender added only a signature reads as the forwarded message.
  const f = cleanEmailText(FORWARD.split('\n\n').slice(1).join('\n\n'));
  assert.match(f.text, /^Forwarded message\nFrom: Tim Thornburg <tim@acme.org>/);
  assert.match(f.text, /Our year-end form takes nine seconds on phones\.\nCan you look before Monday\?/);
  assert.doesNotMatch(f.text, /CONFIDENTIALITY|Chris Lundberg\n/);
  assert.doesNotMatch(f.text, /^>/m);
  // Nothing left after cleaning: the original comes back.
  assert.deepEqual(cleanEmailText('> only a quote'), { text: '> only a quote', trimmed: false });
  assert.deepEqual(cleanEmailText(''), { text: '', trimmed: false });
});

test('an email forwarded in by the team from a client opens the client thread', async () => {
  const folio = await make();
  await folio.add({ text: FORWARD, as: 'auto' }, { actor: staff });
  const items = await folio.comms({ team });
  const email = items.find((m) => m.kind === 'email');
  assert.equal(email.thread, 'client');
  assert.equal(email.direction, 'in');
  assert.equal(email.forwarded, true);
  assert.match(email.forwarded_from, /tim@acme\.org/);
  const t = await folio.clientThread({ team });
  assert.equal(t.waiting, 'us');
  // Forwarded from someone on the team, it stays the team's.
  const internal = FORWARD.replace(/tim@acme\.org/g, 'sam@engine9.ai').replace(/<fwd-1@/, '<fwd-2@');
  const f2 = await Folio.init(new MemoryFs(), { title: 'Internal', now, actor: staff });
  await f2.add({ text: internal, as: 'auto' }, { actor: staff });
  assert.equal((await f2.comms({ team })).find((m) => m.kind === 'email').thread, 'team');
});

test('clientComms shows a client only the client thread, and nothing kept from them', async () => {
  const folio = await make();
  const asked = await folio.receive({ channel: 'email', address: 'tim@acme.org' }, 'Any news?');
  await folio.comment('INTERNAL: upsell the CDN add-on', { actor: staff });
  await folio.post('agent', 'Ran the PageSpeed check: 41/100', { actor: { type: 'agent', id: 'claude', on_behalf_of: 'chris@engine9.ai' } });
  const sent = await folio.comment('We found it: a 4 MB image. Fixed today.', { actor: { ...staff, name: 'Chris' }, to: 'client', attachments: ['attachments/before-after.png'] });
  const oops = await folio.comment('Sorry, wrong folio', { actor: staff, to: 'client' });
  await folio.hideFromClient(oops.path, true, { actor: staff });

  const seen = await folio.clientComms({ team });
  assert.deepEqual(seen.map((m) => m.text), ['Any news?', 'We found it: a 4 MB image. Fixed today.']);
  assert.equal(seen[0].direction, 'in');
  assert.equal(seen[0].from, 'Tim Thornburg');
  assert.equal(seen[1].direction, 'out');
  assert.deepEqual(seen[1].attachments, ['attachments/before-after.png']);
  const everything = JSON.stringify(seen);
  for (const secret of ['INTERNAL', 'PageSpeed', 'sam@engine9.ai', 'wrong folio', 'chris@engine9.ai']) assert.ok(!everything.includes(secret), `${secret} reached the client`);
  assert.equal(seen[0].path, asked.path);
  assert.equal(seen[1].path, sent.path);

  // The team still sees the hidden message, marked.
  const all = await folio.comms({ team });
  assert.equal(all.find((m) => m.path === oops.path).hidden_from_client, true);
  // A hidden message does not count in the timing either: the last thing sent is still the fix.
  assert.equal((await folio.clientThread({ team })).last_out, sent.message.at);

  // Showing it again.
  await folio.hideFromClient(oops.path, false, { actor: staff });
  assert.equal((await folio.clientComms({ team })).length, 3);
  await assert.rejects(folio.hideFromClient('notes/x.md', true), ValidationError);
  await assert.rejects(folio.hideFromClient('comms/2026-01-01-nothing.comment.json', true), ValidationError);
});

test('a folio with messages kept from the client still validates', async () => {
  const { validateFolio } = await import('../src/index.js');
  const folio = await make();
  const m = await folio.comment('Not for Tim', { actor: staff, to: 'client' });
  await folio.hideFromClient(m.path, true, { actor: staff });
  const r = await validateFolio(folio.fs);
  assert.deepEqual((r.errors || r.problems || []).filter((e) => /hidden/.test(JSON.stringify(e))), []);
});
