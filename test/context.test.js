import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ValidationError, changeContacts, changeFolderContext, mergeContext, normalizeFolderContext, resolveAccount, setAccountIn } from '../src/index.js';

test('a folder context keeps references, never secrets', () => {
  const c = normalizeFolderContext({ connections: [{ type: 'Engine9', alias: 'habitat', account_id: 'allegiance_habitat' }, { type: 'sftp', alias: 'drop', role: 'source', host: 'sftp.example.org', credentials: '1Password: Clients/HFHI SFTP' }], contacts: ['Tim Thornburg <Tim@Example.org>'], client_approvers: ['Chris@Engine9.ai'] });
  assert.equal(c.connections[0].type, 'engine9');
  assert.deepEqual(c.contacts, [{ email: 'tim@example.org' }]);
  assert.deepEqual(c.client_approvers, ['chris@engine9.ai']);
  assert.throws(() => normalizeFolderContext({ connections: [{ type: 'sftp', alias: 'x', password: 'hunter2' }] }), ValidationError);
  assert.throws(() => normalizeFolderContext({ connections: [{ type: 'sftp', alias: 'x', credentials: 'AKIAIOSFODNN7EXAMPLE' }] }), ValidationError);
  assert.throws(() => normalizeFolderContext({ connections: [{ type: 'sftp' }] }), ValidationError);
  assert.throws(() => normalizeFolderContext({ connections: [{ type: 'a', alias: 'x' }, { type: 'b', alias: 'X' }] }), ValidationError);
});

test('changes add or replace by alias and email; folios inherit, nearest wins, and empty slots are listed', () => {
  let top = changeFolderContext({}, { connections: [{ type: 'engine9', alias: 'habitat', account_id: 'old' }, { type: 'mcp', alias: 'e9', url: 'https://data.engine9.ai/mcp' }], contacts: [{ name: 'Tim', email: 'tim@example.org', role: 'VP' }] });
  top = changeFolderContext(top, { connections: [{ type: 'engine9', alias: 'habitat', account_id: 'allegiance_habitat' }], contacts: [{ email: 'tim@example.org', answers: 'layouts' }], client_approvers: ['chris@engine9.ai'] });
  assert.equal(top.connections.length, 2);
  assert.equal(top.connections.find((c) => c.alias === 'habitat').account_id, 'allegiance_habitat');
  assert.deepEqual(top.contacts, [{ name: 'Tim', email: 'tim@example.org', role: 'VP', answers: 'layouts' }]);
  const sub = normalizeFolderContext({ connections: [{ type: 'mcp', alias: 'e9', url: 'https://staging/mcp' }] });
  const m = mergeContext([{ path: 'habitat', context: top, agents: true }, { path: 'habitat/2026', context: sub }], { connections: [{ type: 'sftp', alias: 'drop', role: 'source' }] });
  assert.equal(m.connections.find((c) => c.alias === 'e9').url, 'https://staging/mcp');
  assert.equal(m.connections.find((c) => c.alias === 'e9').from, 'habitat/2026');
  assert.equal(m.connections.find((c) => c.alias === 'drop').from, 'folio');
  assert.deepEqual(m.client_approvers, ['chris@engine9.ai']);
  assert.deepEqual(m.agents, [{ path: 'habitat/AGENTS.md', from: 'habitat' }]);
  assert.deepEqual(m.slots.unset.map((s) => s.key), ['destination']);
  assert.equal(changeFolderContext(top, { remove_connections: ['E9'], remove_contacts: ['tim@example.org'], client_approvers: [] }).connections.length, 1);
});

test('a folio has contacts of its own, like a folder, merged over those of the folders and folios above it', () => {
  const top = normalizeFolderContext({ contacts: [{ name: 'Tim', email: 'tim@example.org', role: 'VP Data' }, { name: 'Erin', role: 'IT' }] });
  let own = changeContacts([], { contacts: [{ email: 'Tim@Example.org', role: 'Project lead' }, 'Pat <pat@example.org>'] });
  own = changeContacts(own, { contacts: [{ email: 'pat@example.org', answers: 'test data' }] });
  assert.deepEqual(own, [{ email: 'tim@example.org', role: 'Project lead' }, { email: 'pat@example.org', answers: 'test data' }]);
  assert.throws(() => changeContacts([], { contacts: [{ role: 'nobody' }] }), ValidationError);
  const m = mergeContext([{ path: 'habitat', context: top }, { path: 'habitat/launch', context: { contacts: [{ name: 'Erin', role: 'IT lead' }] } }], { contacts: own });
  assert.deepEqual(m.contacts.map((c) => [c.name || c.email, c.role || null, c.from]), [['tim@example.org', 'Project lead', 'folio'], ['Erin', 'IT lead', 'habitat/launch'], ['pat@example.org', null, 'folio']]);
  assert.ok(m.slots.set.includes('contacts'));
  assert.ok(mergeContext([], { contacts: own }).slots.set.includes('contacts'), 'a folio with only its own contacts has the slot set');
  assert.deepEqual(changeContacts(own, { remove_contacts: ['PAT@example.org'] }).map((c) => c.email), ['tim@example.org']);
});

test('the account: the engine9 connections nearest the folio decide; several need one marked primary', () => {
  const e9 = (alias, account_id, extra = {}) => ({ type: 'engine9', alias, account_id, ...extra });
  assert.deepEqual(resolveAccount([]), { account_id: null, candidates: [] });
  // One on the client folder is the account of every folio inside.
  const one = mergeContext([{ path: 'acme', context: { connections: [e9('main', 'acme_main', { parent_account_id: 'acme' })] } }]);
  assert.deepEqual(one.account, { account_id: 'acme_main', parent_account_id: 'acme', alias: 'main', from: 'acme', candidates: [{ account_id: 'acme_main', parent_account_id: 'acme', alias: 'main', from: 'acme' }] });
  // Several in one place and none marked: no account yet, and the choices are listed.
  const two = mergeContext([{ path: 'acme', context: { connections: [e9('main', 'acme_main'), e9('pac', 'acme_pac')] } }]);
  assert.equal(two.account.account_id, null);
  assert.deepEqual(two.account.candidates.map((c) => c.account_id), ['acme_main', 'acme_pac']);
  // A nearer folder decides over the client folder; the folio's own decides over both.
  const nearer = mergeContext([{ path: 'acme', context: { connections: [e9('main', 'acme_main'), e9('pac', 'acme_pac')] } }, { path: 'acme/pac', context: { connections: [e9('this', 'acme_pac')] } }]);
  assert.deepEqual([nearer.account.account_id, nearer.account.from], ['acme_pac', 'acme/pac']);
  const own = mergeContext([{ path: 'acme', context: { connections: [e9('main', 'acme_main')] } }], { connections: setAccountIn([], { account_id: 'acme_pac', parent_account_id: 'acme' }) });
  assert.deepEqual([own.account.account_id, own.account.parent_account_id, own.account.from], ['acme_pac', 'acme', 'folio']);
  assert.equal(own.account.candidates.length, 2);
});

test('setAccountIn marks one engine9 connection primary, adding it when it is not listed', () => {
  const start = [{ type: 'engine9', alias: 'main', account_id: 'acme_main', primary: true }, { type: 'engine9', alias: 'pac', account_id: 'acme_pac' }, { type: 'sftp', alias: 'drop', role: 'source' }];
  const picked = setAccountIn(start, { account_id: 'acme_pac' });
  assert.deepEqual(picked.map((c) => [c.alias, c.primary]), [['main', undefined], ['pac', true], ['drop', undefined]]);
  assert.equal(resolveAccount(picked.map((c) => ({ ...c, from: 'folio' }))).account_id, 'acme_pac');
  const added = setAccountIn(picked, { account_id: 'acme_c4', parent_account_id: 'acme' });
  assert.deepEqual(added.at(-1), { type: 'engine9', alias: 'acme_c4', account_id: 'acme_c4', parent_account_id: 'acme', primary: true });
  assert.equal(added.filter((c) => c.primary).length, 1);
  assert.throws(() => setAccountIn([], { account_id: '' }), ValidationError);
  assert.throws(() => setAccountIn([], { account_id: 'not an id' }), ValidationError);
});
