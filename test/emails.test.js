import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Folio, MemoryFs, parseEmail } from '../src/index.js';

const now = () => '2026-11-06T15:00:00.000Z';
const actor = { type: 'user', id: 'sam@example.com' };

test('parseEmail reads plain, quoted-printable, base64 and multipart bodies', () => {
  const plain = parseEmail('From: a@x.example\r\nSubject: Hi\r\n\r\nHello there\r\n');
  assert.equal(plain.text, 'Hello there');
  assert.equal(plain.headers.subject, 'Hi');

  const qp = parseEmail('From: a@x.example\r\nSubject: QP\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nCaf=C3=A9 is =\r\nclosed\r\n');
  assert.equal(qp.text, 'Café is closed');

  const b64 = parseEmail(`From: a@x.example\r\nSubject: B\r\nContent-Transfer-Encoding: base64\r\n\r\n${btoa('Base64 body')}\r\n`);
  assert.equal(b64.text, 'Base64 body');

  const multi = parseEmail(
    'From: a@x.example\r\nSubject: M\r\nContent-Type: multipart/alternative; boundary="b1"\r\n\r\n--b1\r\nContent-Type: text/html\r\n\r\n<p>HTML <b>only</b></p>\r\n--b1\r\nContent-Type: text/plain\r\n\r\nPlain wins\r\n--b1--\r\n'
  );
  assert.equal(multi.text, 'Plain wins');

  const htmlOnly = parseEmail('From: a@x.example\r\nSubject: H\r\nContent-Type: text/html\r\n\r\n<p>Line one</p><p>Two &amp; three</p>');
  assert.match(htmlOnly.text, /Line one\nTwo & three/);

  assert.equal(parseEmail('just some text'), null);
});

test('folio.emails lists filed emails with text and linking tickets, filterable by ticket', async () => {
  const folio = await Folio.init(new MemoryFs(), { title: 'Support', now });
  const t1 = await folio.createTicket({ title: 'Login broken', type: 'support' }, { actor });
  const t2 = await folio.createTicket({ title: 'Invoice question', type: 'support' }, { actor });
  const mail = (id, subject, date, body) => `From: c@cust.example\r\nSubject: ${subject}\r\nDate: ${date}\r\nMessage-ID: <${id}@cust.example>\r\n\r\n${body}\r\n`;
  await folio.add({ text: mail('1', 'Cannot log in', 'Mon, 02 Nov 2026 10:00:00 +0000', 'Password reset loops.') }, { ticket: t1.id, actor });
  await folio.add({ text: mail('2', 'Invoice 42', 'Tue, 03 Nov 2026 10:00:00 +0000', 'Charged twice.') }, { ticket: t2.id, actor });
  await folio.add({ text: mail('3', 'Loose email', 'Wed, 04 Nov 2026 10:00:00 +0000', 'No ticket.') }, { actor });

  const all = await folio.emails();
  assert.deepEqual(all.map((e) => e.headers.subject), ['Loose email', 'Invoice 42', 'Cannot log in']);
  assert.deepEqual(all.find((e) => e.headers.subject === 'Invoice 42').tickets, [t2.id]);

  const one = await folio.emails({ ticket: t1.id });
  assert.equal(one.length, 1);
  assert.equal(one[0].text, 'Password reset loops.');
  await assert.rejects(() => folio.emails({ ticket: 'TK-999' }));
});
