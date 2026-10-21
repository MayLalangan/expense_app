'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeApp, signUp, makeGroup } = require('./helpers');

test('budget entries and expenses: create, validate, list, edit, audit', async (t) => {
  const { app, db, cleanup } = await makeApp();
  t.after(cleanup);
  const alice = await signUp(app, 'Alice');
  const bob = await signUp(app, 'Bob');
  const gid = await makeGroup(alice, [[bob, 'editor']]);
  const B = `/api/groups/${gid}/budget-entries`;
  const E = `/api/groups/${gid}/expenses`;

  await t.test('creates a budget entry with server-side metadata', async () => {
    const r = await alice.post(B, { source: 'Salary share', amount: '5000', receivedDate: '2026-10-01', description: 'October', createdBy: 999, createdAt: '1999-01-01' });
    assert.equal(r.status, 201);
    const rec = r.body.record;
    assert.equal(rec.amountMinor, 500000);
    assert.equal(rec.createdBy.id, alice.user.id);
    assert.notEqual(rec.createdAt, '1999-01-01');
    assert.ok(Date.now() - Date.parse(rec.createdAt) < 10000);
    assert.equal(rec.version, 1);
  });

  await t.test('rejects invalid records with field errors', async () => {
    const r = await alice.post(E, { title: '', amount: '-3', expenseDate: '2026-02-30' });
    assert.equal(r.status, 400);
    assert.deepEqual(Object.keys(r.body.details).sort(), ['amount', 'expenseDate', 'title']);
    const b = await alice.post(B, { amount: '1.999', receivedDate: '2026-10-01' });
    assert.ok(b.body.details.source && b.body.details.amount);
    const big = await alice.post(E, { title: 'x', amount: '99999999999', expenseDate: '2026-10-01' });
    assert.equal(big.status, 400);
  });

  await t.test('duplicate submissions with the same clientRequestId create one record', async () => {
    const body = { title: 'Rent', amount: '8000', expenseDate: '2026-10-01', clientRequestId: 'req-12345678' };
    const [a, b] = await Promise.all([alice.post(E, body), alice.post(E, body)]);
    assert.deepEqual([a.status, b.status].sort(), [200, 201]);
    assert.equal(a.body.record.id, b.body.record.id);
    assert.equal((await db.get(`SELECT COUNT(*) AS n FROM expenses WHERE title = 'Rent'`)).n, 1);
  });

  await t.test('lists with search, filters, sorting and pagination', async () => {
    await alice.post(E, { title: 'Coffee beans', amount: '89.90', expenseDate: '2026-10-05', category: 'Food' });
    await alice.post(E, { title: 'Bus card', amount: '450', expenseDate: '2026-09-15', category: 'Transport' });
    await alice.post(E, { title: '100% juice', amount: '25', expenseDate: '2026-10-06', category: 'Food' });

    const food = await alice.get(`${E}?category=Food&sort=amount&order=asc`);
    assert.deepEqual(food.body.items.map((i) => i.title), ['100% juice', 'Coffee beans']);
    assert.equal(food.body.sumMinor, 2500 + 8990);

    const search = await alice.get(`${E}?q=${encodeURIComponent('100%')}`);
    assert.deepEqual(search.body.items.map((i) => i.title), ['100% juice']); // % is literal, not a wildcard

    const range = await alice.get(`${E}?from=2026-10-01&to=2026-10-05&sort=date&order=asc`);
    assert.deepEqual(range.body.items.map((i) => i.title), ['Rent', 'Coffee beans']);

    const paged = await alice.get(`${E}?pageSize=2&page=2&sort=date&order=desc`);
    assert.equal(paged.body.total, 4);
    assert.equal(paged.body.pages, 2);
    assert.equal(paged.body.items.length, 2);

    const injected = await alice.get(`${E}?sort=${encodeURIComponent('amount_minor; DROP TABLE expenses')}`);
    assert.equal(injected.status, 200);
    const cats = await alice.get(`${E}-categories`);
    assert.deepEqual(cats.body.categories, ['Food', 'Transport']);
  });

  await t.test('edits record last editor, bump version and write field-level audit', async () => {
    const created = (await alice.post(E, { title: 'Lamp', amount: '300', expenseDate: '2026-10-02' })).body.record;
    const r = await bob.patch(`${E}/${created.id}`, { version: 1, amount: '350.50', category: 'Home' });
    assert.equal(r.status, 200);
    assert.equal(r.body.record.amountMinor, 35050);
    assert.equal(r.body.record.updatedBy.id, bob.user.id);
    assert.equal(r.body.record.createdBy.id, alice.user.id);
    assert.equal(r.body.record.version, 2);

    const detail = await alice.get(`${E}/${created.id}`);
    const update = detail.body.history.find((h) => h.action === 'updated');
    assert.equal(update.actor.name, 'Bob');
    assert.deepEqual(update.details.changes, { amountMinor: { old: 30000, new: 35050 }, category: { old: null, new: 'Home' } });
  });

  await t.test('stale updates are detected (optimistic concurrency)', async () => {
    const created = (await alice.post(E, { title: 'Chair', amount: '200', expenseDate: '2026-10-02' })).body.record;
    assert.equal((await alice.patch(`${E}/${created.id}`, { version: 1, title: 'Chair (oak)' })).status, 200);
    const stale = await bob.patch(`${E}/${created.id}`, { version: 1, title: 'Chair (pine)' });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.details.currentVersion, 2);
    assert.equal((await alice.get(`${E}/${created.id}`)).body.record.title, 'Chair (oak)');
    assert.equal((await bob.patch(`${E}/${created.id}`, { title: 'x' })).status, 400); // version required
  });

  await t.test('database constraints back up server validation', async () => {
    // Fractional amounts are impossible: the column is an integer type.
    await assert.rejects(db.run(`INSERT INTO expenses (group_id, title, amount_minor, expense_date, created_by, created_at, updated_by, updated_at)
                                    VALUES (?, 'x', '1.5', '2026-01-01', ?, 'now', ?, 'now')`, [gid, alice.user.id, alice.user.id]), /invalid input syntax for type bigint/);
    await assert.rejects(db.run(`INSERT INTO expenses (group_id, title, amount_minor, expense_date, created_by, created_at, updated_by, updated_at)
                                    VALUES (?, 'x', 100, '2026-02-3x', ?, 'now', ?, 'now')`, [gid, alice.user.id, alice.user.id]), /check constraint/);
    await assert.rejects(db.run(`INSERT INTO expenses (group_id, title, amount_minor, expense_date, created_by, created_at, updated_by, updated_at)
                                    VALUES (?, 'x', -100, '2026-01-01', ?, 'now', ?, 'now')`, [gid, alice.user.id, alice.user.id]), /check constraint/);
  });
});
