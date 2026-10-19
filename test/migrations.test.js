'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openDatabase, MIGRATIONS } = require('../src/db');

test('migrations upgrade an existing v1 database without losing data', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expenses-migrate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'app.db');

  // Build a database exactly as release 1 left it, with data in it.
  const v1 = new DatabaseSync(dbPath);
  v1.exec('PRAGMA foreign_keys = ON');
  v1.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  v1.exec(MIGRATIONS[0].sql);
  v1.prepare('INSERT INTO schema_migrations VALUES (1, ?, ?)').run(MIGRATIONS[0].name, 'now');
  v1.exec(`INSERT INTO users (id, name, password_hash, created_at) VALUES (1, 'May', 'x', 'now');
           INSERT INTO groups (id, name, currency, created_by, created_at) VALUES (1, 'Old', 'SEK', 1, 'now');
           INSERT INTO memberships (group_id, user_id, role, created_at, updated_at) VALUES (1, 1, 'admin', 'now', 'now');
           INSERT INTO expenses (group_id, title, amount_minor, expense_date, created_by, created_at, updated_by, updated_at)
             VALUES (1, 'Kept', 500, '2026-10-01', 1, 'now', 1, 'now');
           INSERT INTO suggested_purchases (group_id, item_name, expected_price_minor, purchase_status, expense_id, created_by, created_at, updated_by, updated_at)
             VALUES (1, 'Linked tent', 900, 'purchased', 1, 1, 'now', 1, 'now');`);
  assert.throws(() => v1.exec(`INSERT INTO suggested_purchases (group_id, item_name, created_by, created_at, updated_by, updated_at)
                                VALUES (1, 'No price', 1, 'now', 1, 'now')`), /NOT NULL/);
  assert.throws(() => v1.exec(`INSERT INTO groups (name, currency, created_by, created_at) VALUES ('x', 'PHP', 1, 'now')`), /CHECK/);
  v1.close();

  const db = openDatabase(dbPath);
  t.after(() => db.close());
  assert.deepEqual(db.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map((r) => r.id), [1, 2, 3]);
  assert.deepEqual({ ...db.prepare('SELECT name, currency FROM groups WHERE id = 1').get() }, { name: 'Old', currency: 'SEK' });
  assert.equal(db.prepare('SELECT title FROM expenses').get().title, 'Kept');
  // Migration 3: existing suggestions keep their data and link; price is now optional.
  assert.deepEqual({ ...db.prepare('SELECT item_name, expected_price_minor, purchase_status, expense_id FROM suggested_purchases').get() },
    { item_name: 'Linked tent', expected_price_minor: 900, purchase_status: 'purchased', expense_id: 1 });
  db.exec(`INSERT INTO suggested_purchases (group_id, item_name, purchase_status, created_by, created_at, updated_by, updated_at)
           VALUES (1, 'Done, no price, no expense', 'purchased', 1, 'now', 1, 'now')`);
  db.exec(`INSERT INTO expenses (id, group_id, title, amount_minor, expense_date, created_by, created_at, updated_by, updated_at)
           VALUES (2, 1, 'Second', 100, '2026-10-02', 1, 'now', 1, 'now')`);
  // A linked expense still implies the item is done.
  assert.throws(() => db.exec(`INSERT INTO suggested_purchases (group_id, item_name, purchase_status, expense_id, created_by, created_at, updated_by, updated_at)
                               VALUES (1, 'Linked but open', 'planned', 2, 1, 'now', 1, 'now')`), /CHECK/);
  db.exec(`INSERT INTO groups (name, currency, created_by, created_at) VALUES ('Pinoy', 'PHP', 1, 'now')`);
  assert.throws(() => db.exec(`INSERT INTO groups (name, currency, created_by, created_at) VALUES ('x', 'XYZ', 1, 'now')`), /CHECK/);
  // Foreign keys are back on and still point at the rebuilt table.
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.throws(() => db.exec(`INSERT INTO memberships (group_id, user_id, role, created_at, updated_at) VALUES (999, 1, 'admin', 'now', 'now')`), /FOREIGN KEY/);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});
