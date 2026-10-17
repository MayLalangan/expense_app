'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeApp, signUp, makeGroup } = require('./helpers');

test('deletion request and approval workflow', async (t) => {
  const { app, db, cleanup } = makeApp();
  t.after(cleanup);
  const alice = await signUp(app, 'Alice'); // admin
  const bob = await signUp(app, 'Bob'); // approver
  const ed = await signUp(app, 'Ed'); // editor
  const gid = await makeGroup(alice, [[bob, 'approver'], [ed, 'editor']]);
  const G = `/api/groups/${gid}`;
  const dash = async () => (await alice.get(`${G}/dashboard`)).body;

  await alice.post(`${G}/budget-entries`, { source: 'Pool', amount: '1000', receivedDate: '2026-10-01' });
  const exp = (await ed.post(`${G}/expenses`, { title: 'Tickets', amount: '200', expenseDate: '2026-10-02' })).body.record;
  const E = `${G}/expenses/${exp.id}`;

  await t.test('a reason is required', async () => {
    assert.equal((await ed.post(`${E}/deletion-requests`, { reason: '   ' })).status, 400);
  });

  let reqId;
  await t.test('pending requests keep the record visible, counted and locked', async () => {
    const r = await ed.post(`${E}/deletion-requests`, { reason: 'Refunded' });
    assert.equal(r.status, 201);
    reqId = r.body.deletionRequest.id;
    assert.equal((await ed.post(`${E}/deletion-requests`, { reason: 'again' })).status, 409);

    const list = await alice.get(`${G}/expenses`);
    const item = list.body.items.find((i) => i.id === exp.id);
    assert.equal(item.pendingDeletion.id, reqId);
    assert.equal((await alice.get(`${G}/expenses?pendingDeletion=1`)).body.total, 1);

    const d = await dash();
    assert.equal(d.expenseTotalMinor, 20000);
    assert.equal(d.pendingDeletionCount, 1);
    assert.equal(d.pendingDeletionExpenseMinor, 20000);
    assert.equal((await ed.patch(E, { version: exp.version, title: 'x' })).status, 409);
  });

  await t.test('requester and editors cannot decide; requester can see it', async () => {
    assert.equal((await ed.post(`${G}/deletion-requests/${reqId}/approve`)).status, 403);
    const pending = (await ed.get(`${G}/deletion-requests`)).body.requests;
    assert.equal(pending[0].canDecide, false);
    assert.equal(pending[0].recordTitle, 'Tickets');
  });

  await t.test('an approver cannot approve their own request', async () => {
    const own = (await bob.post(`${G}/budget-entries`, { source: 'Gift', amount: '50', receivedDate: '2026-10-01' })).body.record;
    const r = await bob.post(`${G}/budget-entries/${own.id}/deletion-requests`, { reason: 'Mistake' });
    const id = r.body.deletionRequest.id;
    assert.equal((await bob.post(`${G}/deletion-requests/${id}/approve`)).status, 403);
    assert.equal((await bob.post(`${G}/deletion-requests/${id}/reject`)).status, 403);
    // The database also refuses it.
    assert.throws(() => db.prepare(`UPDATE deletion_requests SET status = 'approved', decided_by = ?, decided_at = 'now' WHERE id = ?`).run(bob.user.id, id), /CHECK/);
    assert.equal((await bob.post(`${G}/deletion-requests/${id}/cancel`)).status, 200);
    assert.equal((await alice.post(`${G}/deletion-requests/${id}/cancel`)).status, 403);
  });

  await t.test('rejection keeps the record and informs the requester; a new request is allowed', async () => {
    const r = await bob.post(`${G}/deletion-requests/${reqId}/reject`, { reason: 'Receipt is valid' });
    assert.equal(r.status, 200);
    assert.equal((await bob.post(`${G}/deletion-requests/${reqId}/approve`)).status, 409); // repeated action
    const notes = (await ed.get('/api/notifications')).body;
    assert.equal(notes.unread, 1);
    assert.match(notes.notifications[0].message, /rejected.*Tickets.*Receipt is valid/);
    const rejected = (await ed.get(`${G}/deletion-requests?status=rejected`)).body.requests;
    assert.equal(rejected[0].decidedBy, 'Bob');
    assert.equal((await dash()).expenseTotalMinor, 20000);
    const again = await ed.post(`${E}/deletion-requests`, { reason: 'Actually refunded' });
    assert.equal(again.status, 201);
    reqId = again.body.deletionRequest.id;
  });

  await t.test('approval archives (not hard-deletes) and updates totals', async () => {
    const r = await alice.post(`${G}/deletion-requests/${reqId}/approve`, { reason: 'Confirmed refund' });
    assert.equal(r.status, 200);
    const row = db.prepare('SELECT * FROM expenses WHERE id = ?').get(exp.id);
    assert.equal(row.status, 'archived');
    assert.equal(row.archived_by, alice.user.id);

    const d = await dash();
    assert.equal(d.expenseTotalMinor, 0);
    assert.equal(d.balanceMinor, 105000); // includes the ₱50 entry whose request was cancelled
    assert.equal(d.pendingDeletionCount, 0);
    assert.equal((await alice.get(`${G}/expenses`)).body.total, 0);
    assert.equal((await alice.get(`${G}/expenses?status=archived`)).body.total, 1);

    const detail = (await ed.get(E)).body;
    assert.equal(detail.record.status, 'archived');
    const actions = detail.history.map((h) => h.action);
    assert.deepEqual(actions, ['created', 'deletion_requested', 'deletion_rejected', 'deletion_requested', 'deletion_approved', 'archived']);
    assert.equal((await ed.patch(E, { version: detail.record.version, title: 'x' })).status, 409);
    assert.equal((await ed.post(`${E}/deletion-requests`, { reason: 'x' })).status, 409);
  });

  await t.test('same workflow applies to suggested purchases', async () => {
    const s = (await ed.post(`${G}/suggestions`, { itemName: 'Tent', expectedPrice: '1500' })).body.record;
    const r = await ed.post(`${G}/suggestions/${s.id}/deletion-requests`, { reason: 'Not needed' });
    await bob.post(`${G}/deletion-requests/${r.body.deletionRequest.id}/approve`);
    assert.equal((await ed.get(`${G}/suggestions/${s.id}`)).body.record.status, 'archived');
    assert.equal((await dash()).suggestionCount, 0);
  });
});
