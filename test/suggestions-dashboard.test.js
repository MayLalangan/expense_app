'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeApp, signUp, makeGroup } = require('./helpers');
const { computeTotals } = require('../src/dashboard');

test('suggested purchases: statuses, totals and expense linking', async (t) => {
  const { app, db, cleanup } = await makeApp();
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
    assert.equal(u.body.record.purchaseStatus, 'purchased'); // still checked off
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
    assert.deepEqual(purchased.items.map((i) => i.itemName).sort(), ['Stove', 'Tent']);
  });

  await t.test('cancelled suggestions are excluded from the estimate', async () => {
    const st = (await ed.get(`${S}/${stove.id}`)).body.record;
    await ed.post(`${S}/${stove.id}/done`, { version: st.version, done: false });
    assert.equal((await computeTotals(db, gid)).suggestionEstimateMinor, 40050);
    const st2 = (await ed.get(`${S}/${stove.id}`)).body.record;
    await ed.patch(`${S}/${stove.id}`, { version: st2.version, purchaseStatus: 'cancelled' });
    assert.equal((await computeTotals(db, gid)).suggestionEstimateMinor, 0);
  });
});

test('dashboard calculations', async (t) => {
  const { app, db, cleanup } = await makeApp();
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
  assert.deepEqual((await computeTotals(db, ogid)).expenseTotalMinor, 99900);
});

test('suggestions checklist: optional price, check off and uncheck', async (t) => {
  const { app, db, cleanup } = await makeApp();
  t.after(cleanup);
  const alice = await signUp(app, 'Alice');
  const ed = await signUp(app, 'Ed');
  const viewer = await signUp(app, 'Viewer');
  const gid = await makeGroup(alice, [[ed, 'editor'], [viewer, 'viewer']]);
  const S = `/api/groups/${gid}/suggestions`;

  const rice = await ed.post(S, { itemName: 'Rice cooker' });
  assert.equal(rice.status, 201, JSON.stringify(rice.body));
  assert.equal(rice.body.record.expectedPriceMinor, null);
  const cord = (await ed.post(S, { itemName: 'Extension cord', expectedPrice: '350'})).body.record;
  assert.equal((await ed.post(S, { itemName: 'X', expectedPrice: 'abc' })).status, 400); // still validated when given

  let d = (await computeTotals(db, gid));
  assert.equal(d.suggestionEstimateMinor, 35000);
  assert.equal(d.suggestionCount, 2);
  assert.equal(d.suggestionUnpricedCount, 1);

  await t.test('checking an item marks it done without creating an expense', async () => {
    const r = await ed.post(`${S}/${cord.id}/done`, { version: cord.version, done: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.record.purchaseStatus, 'purchased');
    assert.equal(r.body.record.expenseId, null);
    d = (await computeTotals(db, gid));
    assert.equal(d.suggestionEstimateMinor, 0);
    assert.equal(d.expenseTotalMinor, 0);
    assert.equal((await ed.post(`${S}/${cord.id}/done`, { version: cord.version, done: false })).status, 409); // stale version
  });

  await t.test('list sections by checklist state', async () => {
    assert.deepEqual((await ed.get(`${S}?state=open`)).body.items.map((i) => i.itemName), ['Rice cooker']);
    assert.deepEqual((await ed.get(`${S}?state=done`)).body.items.map((i) => i.itemName), ['Extension cord']);
    assert.equal((await ed.get(`${S}?state=bogus`)).status, 400);
  });

  await t.test('unchecking restores the previous status', async () => {
    const r0 = (await alice.patch(`${S}/${rice.body.record.id}`, { version: 1, purchaseStatus: 'approved' })).body.record;
    const checked = (await ed.post(`${S}/${r0.id}/done`, { version: r0.version, done: true })).body.record;
    const un = await ed.post(`${S}/${r0.id}/done`, { version: checked.version, done: false });
    assert.equal(un.body.record.purchaseStatus, 'approved');
    const history = (await ed.get(`${S}/${r0.id}`)).body.history.map((h) => h.action);
    assert.deepEqual(history, ['created', 'updated', 'checked', 'unchecked']);
  });

  await t.test('a done item can still get a linked expense, and cannot be unchecked while linked', async () => {
    const c = (await ed.get(`${S}/${cord.id}`)).body.record;
    const link = await ed.post(`${S}/${cord.id}/link-expense`, { version: c.version, createExpense: { title: 'Extension cord', amount: '330', expenseDate: '2026-10-19' } });
    assert.equal(link.status, 200, JSON.stringify(link.body));
    assert.equal((await computeTotals(db, gid)).expenseTotalMinor, 33000);
    assert.equal((await ed.post(`${S}/${cord.id}/done`, { version: link.body.record.version, done: false })).status, 409);
  });

  await t.test('viewers cannot check items off', async () => {
    const r = (await ed.get(`${S}/${rice.body.record.id}`)).body.record;
    assert.equal((await viewer.post(`${S}/${r.id}/done`, { version: r.version, done: true })).status, 403);
  });
});
