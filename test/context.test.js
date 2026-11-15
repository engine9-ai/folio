import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ValidationError, changeFolderContext, mergeContext, normalizeFolderContext } from '../src/index.js';

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
