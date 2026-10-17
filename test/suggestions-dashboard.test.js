'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeApp, signUp, makeGroup } = require('./helpers');
const { computeTotals } = require('../src/dashboard');

test('suggested purchases: statuses, totals and expense linking', async (t) => {
  const { app, db, cleanup } = makeApp();
  t.after(cleanup);
  const alice = await signUp(app, 'Alice');
  const ed = await signUp(app, 'Ed');
  const viewer = await signUp(app, 'Viewer');
  const outsider = await signUp(app, 'Outsider');
  const gid = await makeGroup(alice, [[ed, 'editor'], [viewer, 'viewer']]);
  const G = `/api/groups/${gid}`;
  const S = `${G}/suggestions`;
  await alice.post(`${G}/budget-entries`, { source: 'Pool', amount: '2000', receivedDate: '2026-10-01' });

  const tent = (await ed.post(S, { itemName: 'Tent', expectedPrice: '1500', targetDate: '2026-12-01', productUrl: 'https://shop.example/tent' })).body.record;
  const stove = (await ed.post(S, { itemName: 'Stove', expectedPrice: '400.50' })).body.record;

  await t.test('validates fields and statuses', async () => {
    assert.equal(tent.purchaseStatus, 'suggested');
    const bad = await ed.post(S, { itemName: 'X', expectedPrice: '10', productUrl: 'javascript:alert(1)' });
    assert.equal(bad.status, 400);
    assert.ok(bad.body.details.productUrl);
    assert.equal((await ed.post(S, { itemName: 'X', expectedPrice: '10', purchaseStatus: 'purchased' })).status, 400);
    assert.equal((await viewer.post(S, { itemName: 'X', expectedPrice: '10' })).status, 403);
  });

  await t.test('only approvers can mark a suggestion Approved', async () => {
    assert.equal((await ed.patch(`${S}/${tent.id}`, { version: 1, purchaseStatus: 'approved' })).status, 403);
    const r = await alice.patch(`${S}/${tent.id}`, { version: 1, purchaseStatus: 'approved' });
    assert.equal(r.status, 200);
    assert.equal((await ed.patch(`${S}/${tent.id}`, { version: 2, purchaseStatus: 'planned' })).status, 200);
  });

  await t.test('estimates are separate from actual totals', async () => {
    const d = (await alice.get(`${G}/dashboard`)).body;
    assert.equal(d.suggestionEstimateMinor, 150000 + 40050);
    assert.equal(d.suggestionCount, 2);
    assert.equal(d.expenseTotalMinor, 0);
    assert.equal(d.balanceMinor, 200000);
  });

  await t.test('converting a suggestion into an expense counts it once', async () => {
    const cur = (await ed.get(`${S}/${tent.id}`)).body.record;
    const r = await ed.post(`${S}/${tent.id}/link-expense`, { version: cur.version, createExpense: { title: 'Tent', amount: '1450', expenseDate: '2026-11-20', category: 'Gear' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.record.purchaseStatus, 'purchased');
    const d = (await alice.get(`${G}/dashboard`)).body;
    assert.equal(d.expenseTotalMinor, 145000);
    assert.equal(d.suggestionEstimateMinor, 40050); // tent no longer in estimate
    assert.equal(d.suggestionCount, 1);
    assert.equal(d.balanceMinor, 200000 - 145000);

    const exp = (await ed.get(`${G}/expenses/${r.body.expenseId}`)).body.record;
    assert.equal(exp.linkedSuggestion.id, tent.id);
    const detail = (await ed.get(`${S}/${tent.id}`)).body;
    assert.equal(detail.record.linkedExpense.id, r.body.expenseId);
    assert.ok(detail.history.some((h) => h.action === 'linked_expense'));
  });

  await t.test('an expense can only be linked once and status is locked while linked', async () => {
    const tentNow = (await ed.get(`${S}/${tent.id}`)).body.record;
    const st = (await ed.get(`${S}/${stove.id}`)).body.record;
    const r = await ed.post(`${S}/${stove.id}/link-expense`, { version: st.version, expenseId: tentNow.expenseId });
    assert.equal(r.status, 409);
    assert.equal((await ed.patch(`${S}/${tent.id}`, { version: tentNow.version, purchaseStatus: 'planned' })).status, 409);
  });

  await t.test('linking an existing expense and unlinking', async () => {
    const e = (await ed.post(`${G}/expenses`, { title: 'Camping stove', amount: '380', expenseDate: '2026-11-01' })).body.record;
    const st = (await ed.get(`${S}/${stove.id}`)).body.record;
    const r = await ed.post(`${S}/${stove.id}/link-expense`, { version: st.version, expenseId: e.id });
    assert.equal(r.status, 200);
    const u = await ed.post(`${S}/${stove.id}/unlink-expense`, { version: r.body.record.version });
    assert.equal(u.status, 200);
    assert.equal(u.body.record.purchaseStatus, 'planned');
    assert.equal(u.body.record.expenseId, null);
  });

  await t.test('cannot link expenses from another group', async () => {
    const og = await makeGroup(outsider, [], 'Other');
    const foreign = (await outsider.post(`/api/groups/${og}/expenses`, { title: 'Foreign', amount: '1', expenseDate: '2026-01-01' })).body.record;
    const st = (await ed.get(`${S}/${stove.id}`)).body.record;
    assert.equal((await ed.post(`${S}/${stove.id}/link-expense`, { version: st.version, expenseId: foreign.id })).status, 404);
  });

  await t.test('list filters by status', async () => {
    const purchased = (await ed.get(`${S}?purchaseStatus=purchased`)).body;
    assert.deepEqual(purchased.items.map((i) => i.itemName), ['Tent']);
  });

  await t.test('cancelled suggestions are excluded from the estimate', async () => {
    const st = (await ed.get(`${S}/${stove.id}`)).body.record;
    await ed.patch(`${S}/${stove.id}`, { version: st.version, purchaseStatus: 'cancelled' });
    assert.equal(computeTotals(db, gid).suggestionEstimateMinor, 0);
  });
});

test('dashboard calculations', async (t) => {
  const { app, db, cleanup } = makeApp();
  t.after(cleanup);
  const alice = await signUp(app, 'Alice');
  const other = await signUp(app, 'Other');
  const gid = await makeGroup(alice);
  const ogid = await makeGroup(other, [], 'Other');
  const G = `/api/groups/${gid}`;

  let d = (await alice.get(`${G}/dashboard`)).body;
  assert.equal(d.utilizationPercent, null);
  assert.equal(d.balanceMinor, 0);

  // 0.10 + 0.20 must be exactly 0.30.
  await alice.post(`${G}/budget-entries`, { source: 'A', amount: '0.10', receivedDate: '2026-10-01' });
  await alice.post(`${G}/budget-entries`, { source: 'B', amount: '0.20', receivedDate: '2026-10-01' });
  await alice.post(`${G}/expenses`, { title: 'C', amount: '0.10', expenseDate: '2026-10-01' });
  // Data in another group must not leak into totals.
  await other.post(`/api/groups/${ogid}/expenses`, { title: 'Z', amount: '999', expenseDate: '2026-10-01' });

  d = (await alice.get(`${G}/dashboard`)).body;
  assert.equal(d.budgetTotalMinor, 30);
  assert.equal(d.expenseTotalMinor, 10);
  assert.equal(d.balanceMinor, 20);
  assert.equal(d.utilizationPercent, 33.3);
  assert.equal(d.currency, 'PHP');
  assert.ok(d.recentActivity.length > 0);
  assert.ok(d.recentActivity.every((a) => a.recordType !== 'expense' || a.details.values.title !== 'Z'));

  // Overspending gives a negative balance and >100% utilization.
  await alice.post(`${G}/expenses`, { title: 'Big', amount: '1', expenseDate: '2026-10-01' });
  d = (await alice.get(`${G}/dashboard`)).body;
  assert.equal(d.balanceMinor, -80);
  assert.equal(d.utilizationPercent, 366.7);
  assert.deepEqual(computeTotals(db, ogid).expenseTotalMinor, 99900);
});
