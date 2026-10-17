'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp, signUp, makeGroup, PDF } = require('./helpers');

test('audit log is append-only and member-restricted', async (t) => {
  const { app, db, cleanup } = makeApp();
  t.after(cleanup);
  const alice = await signUp(app, 'Alice');
  const outsider = await signUp(app, 'Outsider');
  const gid = await makeGroup(alice);
  await alice.post(`/api/groups/${gid}/expenses`, { title: 'Soap', amount: '20', expenseDate: '2026-10-01' });

  const before = db.prepare('SELECT * FROM audit_log ORDER BY id').all();
  assert.ok(before.length >= 2);
  assert.throws(() => db.prepare(`UPDATE audit_log SET action = 'tampered'`).run(), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM audit_log').run(), /append-only/);
  assert.deepEqual(db.prepare('SELECT * FROM audit_log ORDER BY id').all(), before);

  for (const row of before) {
    assert.ok(row.actor_id && row.created_at && row.action && row.record_type);
    assert.ok(!/password|token|storage_name/i.test(row.details || ''));
  }
  assert.equal((await outsider.get(`/api/groups/${gid}/activity`)).status, 404);
  const activity = (await alice.get(`/api/groups/${gid}/activity`)).body.activity;
  assert.equal(activity[0].action, 'created');
});

test('end-to-end journey across two members', async (t) => {
  const { app, cleanup } = makeApp();
  t.after(cleanup);

  // Owner signs up, creates a group and an invite link.
  const owner = await signUp(app, 'May');
  const gid = (await owner.post('/api/groups', { name: 'Trip fund', currency: 'EUR' })).body.group.id;
  const token = (await owner.post(`/api/groups/${gid}/invitations`, { role: 'approver' })).body.invitation.token;

  // Partner signs up, opens the link, joins.
  const partner = await signUp(app, 'Sam');
  assert.equal((await partner.post(`/api/invitations/${token}/accept`)).body.groupId, gid);

  // Money in, money out, with a receipt.
  const G = `/api/groups/${gid}`;
  await owner.post(`${G}/budget-entries`, { source: 'May', amount: '500', receivedDate: '2026-10-01' });
  await partner.post(`${G}/budget-entries`, { source: 'Sam', amount: '500', receivedDate: '2026-10-01' });
  const hotel = (await partner.post(`${G}/expenses`, { title: 'Hotel', amount: '320.40', expenseDate: '2026-10-10', category: 'Lodging' })).body.record;
  assert.equal((await partner.upload(`${G}/expenses/${hotel.id}/attachments`, [{ buffer: PDF, name: 'hotel.pdf' }])).status, 201);

  // A suggestion becomes a real purchase.
  const s = (await owner.post(`${G}/suggestions`, { itemName: 'Museum pass', expectedPrice: '60' })).body.record;
  await owner.post(`${G}/suggestions/${s.id}/link-expense`, { version: s.version, createExpense: { title: 'Museum pass', amount: '55', expenseDate: '2026-10-11' } });

  // A mistaken expense goes through deletion approval.
  const dup = (await owner.post(`${G}/expenses`, { title: 'Hotel (dup)', amount: '320.40', expenseDate: '2026-10-10' })).body.record;
  const dr = (await owner.post(`${G}/expenses/${dup.id}/deletion-requests`, { reason: 'Entered twice' })).body.deletionRequest;
  assert.equal((await partner.get(`${G}/dashboard`)).body.pendingDeletionCount, 1);
  await partner.post(`${G}/deletion-requests/${dr.id}/approve`);

  const d = (await owner.get(`${G}/dashboard`)).body;
  assert.equal(d.currency, 'EUR');
  assert.equal(d.budgetTotalMinor, 100000);
  assert.equal(d.expenseTotalMinor, 32040 + 5500);
  assert.equal(d.balanceMinor, 100000 - 37540);
  assert.equal(d.pendingDeletionCount, 0);
  assert.equal(d.suggestionCount, 0);
  assert.equal((await owner.get('/api/notifications')).body.unread, 1);

  // Signing out ends access.
  await owner.post('/api/auth/signout');
  assert.equal((await owner.get(`${G}/dashboard`)).status, 401);
  assert.equal((await request(app).get('/')).status, 200);
});
