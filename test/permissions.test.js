'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeApp, signUp, makeGroup } = require('./helpers');
const { can } = require('../src/permissions');

const expense = { title: 'Groceries', amount: '100', expenseDate: '2026-10-01' };

test('role matrix', () => {
  assert.equal(can('viewer', 'read'), true);
  assert.equal(can('viewer', 'write'), false);
  assert.equal(can('editor', 'write'), true);
  assert.equal(can('editor', 'decideDeletion'), false);
  assert.equal(can('approver', 'decideDeletion'), true);
  assert.equal(can('approver', 'manageMembers'), false);
  assert.equal(can('admin', 'manageMembers'), true);
});

test('group isolation and role enforcement on the server', async (t) => {
  const { app, cleanup } = makeApp();
  t.after(cleanup);
  const admin = await signUp(app, 'Admin');
  const editor = await signUp(app, 'Editor');
  const viewer = await signUp(app, 'Viewer');
  const outsider = await signUp(app, 'Outsider');
  const gid = await makeGroup(admin, [[editor, 'editor'], [viewer, 'viewer']]);
  const otherGid = await makeGroup(outsider, [], 'Other group');
  const created = await editor.post(`/api/groups/${gid}/expenses`, expense);
  assert.equal(created.status, 201);
  const eid = created.body.record.id;

  await t.test('outsiders cannot see the group or its records', async () => {
    assert.equal((await outsider.get(`/api/groups/${gid}`)).status, 404);
    assert.equal((await outsider.get(`/api/groups/${gid}/expenses`)).status, 404);
    assert.equal((await outsider.get(`/api/groups/${gid}/expenses/${eid}`)).status, 404);
    assert.equal((await outsider.get(`/api/groups/${gid}/dashboard`)).status, 404);
    assert.equal((await outsider.post(`/api/groups/${gid}/expenses`, expense)).status, 404);
    const groups = (await outsider.get('/api/groups')).body.groups.map((g) => g.id);
    assert.deepEqual(groups, [otherGid]);
  });

  await t.test('records cannot be reached through another group id (IDOR)', async () => {
    assert.equal((await outsider.get(`/api/groups/${otherGid}/expenses/${eid}`)).status, 404);
    assert.equal((await outsider.patch(`/api/groups/${otherGid}/expenses/${eid}`, { version: 1, title: 'hacked' })).status, 404);
    assert.equal((await outsider.post(`/api/groups/${otherGid}/expenses/${eid}/deletion-requests`, { reason: 'x' })).status, 404);
  });

  await t.test('viewers can read but not write', async () => {
    assert.equal((await viewer.get(`/api/groups/${gid}/expenses/${eid}`)).status, 200);
    assert.equal((await viewer.post(`/api/groups/${gid}/expenses`, expense)).status, 403);
    assert.equal((await viewer.patch(`/api/groups/${gid}/expenses/${eid}`, { version: 1, title: 'x' })).status, 403);
    assert.equal((await viewer.post(`/api/groups/${gid}/expenses/${eid}/deletion-requests`, { reason: 'x' })).status, 403);
  });

  await t.test('only admins manage members', async () => {
    assert.equal((await editor.post(`/api/groups/${gid}/invitations`, { role: 'admin' })).status, 403);
    assert.equal((await editor.patch(`/api/groups/${gid}/members/${viewer.user.id}`, { role: 'admin' })).status, 403);
    assert.equal((await admin.patch(`/api/groups/${gid}/members/${viewer.user.id}`, { role: 'editor' })).status, 200);
  });

  await t.test('the last admin cannot be demoted or removed', async () => {
    assert.equal((await admin.patch(`/api/groups/${gid}/members/${admin.user.id}`, { role: 'editor' })).status, 409);
    assert.equal((await admin.post(`/api/groups/${gid}/members/${admin.user.id}/revoke`)).status, 409);
  });

  await t.test('revoked members immediately lose access', async () => {
    assert.equal((await admin.post(`/api/groups/${gid}/members/${editor.user.id}/revoke`)).status, 200);
    assert.equal((await editor.get(`/api/groups/${gid}/expenses`)).status, 404);
    assert.equal((await editor.post(`/api/groups/${gid}/expenses`, expense)).status, 404);
  });
});

test('invitation links are single-use and expire', async (t) => {
  const { app, db, cleanup } = makeApp();
  t.after(cleanup);
  const admin = await signUp(app, 'Admin');
  const joiner = await signUp(app, 'Joiner');
  const late = await signUp(app, 'Late');
  const gid = await makeGroup(admin);

  const inv = await admin.post(`/api/groups/${gid}/invitations`, { role: 'approver' });
  assert.equal(inv.status, 201);
  const { token } = inv.body.invitation;
  // Only a hash of the token is stored.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM invitations WHERE token_hash = ?').get(token).n, 0);

  const preview = await joiner.get(`/api/invitations/${token}`);
  assert.equal(preview.body.invitation.role, 'approver');
  const accept = await joiner.post(`/api/invitations/${token}/accept`);
  assert.equal(accept.status, 200);
  assert.equal((await joiner.get(`/api/groups/${gid}`)).body.group.role, 'approver');
  assert.equal((await late.post(`/api/invitations/${token}/accept`)).status, 404);

  const expired = await admin.post(`/api/groups/${gid}/invitations`, { role: 'viewer' });
  db.prepare(`UPDATE invitations SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).run(expired.body.invitation.id);
  assert.equal((await late.post(`/api/invitations/${expired.body.invitation.token}/accept`)).status, 404);

  const revoked = await admin.post(`/api/groups/${gid}/invitations`, { role: 'viewer' });
  await admin.post(`/api/groups/${gid}/invitations/${revoked.body.invitation.id}/revoke`);
  assert.equal((await late.post(`/api/invitations/${revoked.body.invitation.token}/accept`)).status, 404);
});
