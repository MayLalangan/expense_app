'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase, MIGRATIONS, toPositional, parseDatabaseUrl } = require('../src/db');
const { clean } = require('../src/config');

const config = (pgliteDir) => ({ databaseUrl: null, pgliteDir });

test('migrations run once and survive a restart with data intact', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expenses-migrate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  let db = await openDatabase(config(dir));
  await db.run(`INSERT INTO users (name, password_hash, created_at) VALUES ('May', 'x', 'now')`);
  await db.close();

  // Re-opening applies nothing twice and keeps the data.
  db = await openDatabase(config(dir));
  t.after(() => db.close());
  assert.deepEqual((await db.all('SELECT id FROM schema_migrations ORDER BY id')).map((r) => r.id), MIGRATIONS.map((m) => m.id));
  assert.equal((await db.get('SELECT name FROM users')).name, 'May');
});

test('schema constraints', async (t) => {
  const db = await openDatabase(config('memory://'));
  t.after(() => db.close());
  await db.run(`INSERT INTO users (id, name, password_hash, created_at) VALUES (1, 'May', 'x', 'now')`);
  await db.run(`INSERT INTO groups (id, name, currency, created_by, created_at) VALUES (1, 'Home', 'PHP', 1, 'now')`);
  await db.run(`INSERT INTO expenses (id, group_id, title, amount_minor, expense_date, created_by, created_at, updated_by, updated_at)
                VALUES (1, 1, 'Rice', 500, '2026-10-01', 1, 'now', 1, 'now')`);

  // Names are unique ignoring case.
  await assert.rejects(db.run(`INSERT INTO users (name, password_hash, created_at) VALUES ('MAY', 'x', 'now')`), /duplicate key/);
  await assert.rejects(db.run(`INSERT INTO groups (name, currency, created_by, created_at) VALUES ('x', 'XYZ', 1, 'now')`), /check constraint/);
  await assert.rejects(db.run(`INSERT INTO memberships (group_id, user_id, role, created_at, updated_at) VALUES (999, 1, 'admin', 'now', 'now')`), /foreign key/);
  // Explicit ids (used by restore/import) don't break later inserts once sequences are reset.
  await db.query(`SELECT setval(pg_get_serial_sequence('users', 'id'), (SELECT MAX(id) FROM users))`);
  assert.equal(await db.insert(`INSERT INTO users (name, password_hash, created_at) VALUES ('Sam', 'x', 'now')`), 2);

  // Suggestions: price optional; done without an expense is fine; a linked expense implies done.
  await db.run(`INSERT INTO suggested_purchases (group_id, item_name, purchase_status, created_by, created_at, updated_by, updated_at)
                VALUES (1, 'No price, done', 'purchased', 1, 'now', 1, 'now')`);
  await assert.rejects(db.run(`INSERT INTO suggested_purchases (group_id, item_name, purchase_status, expense_id, created_by, created_at, updated_by, updated_at)
                               VALUES (1, 'Linked but open', 'planned', 1, 1, 'now', 1, 'now')`), /check constraint/);
});

test('row level security blocks non-owner roles (Supabase API roles)', async (t) => {
  const db = await openDatabase(config('memory://'));
  t.after(() => db.close());
  const off = await db.all(`SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                            WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity`);
  assert.deepEqual(off, [], 'every table has RLS enabled');
  await db.run(`INSERT INTO users (name, password_hash, created_at) VALUES ('May', 'secret-hash', 'now')`);
  await db.exec(`CREATE ROLE api_user NOLOGIN; GRANT SELECT ON users TO api_user;`);
  await db.tx(async (t) => {
    await t.exec('SET LOCAL ROLE api_user');
    assert.equal((await t.get('SELECT COUNT(*) AS n FROM users')).n, 0); // RLS hides every row
  });
});

test('placeholder conversion skips literals, identifiers, comments and dollar quotes', () => {
  assert.equal(toPositional(`SELECT ? , '?', "a?" -- what?
    , $fn$ ? $fn$, ?`), `SELECT $1 , '?', "a?" -- what?
    , $fn$ ? $fn$, $2`);
  assert.equal(toPositional(`details::jsonb #>> '{a,b}' = ? AND x = ?`), `details::jsonb #>> '{a,b}' = $1 AND x = $2`);
});

test('DATABASE_URL problems are explained without revealing the password', () => {
  const ok = parseDatabaseUrl('postgresql://postgres.abc:S3cretPass@aws-1-eu-central-1.pooler.supabase.com:5432/postgres');
  assert.equal(ok.hostname, 'aws-1-eu-central-1.pooler.supabase.com');
  assert.ok(parseDatabaseUrl('postgresql://postgres.abc:p%23ss@host.example:5432/postgres')); // encoded # is fine
  const cases = {
    'postgresql://postgres.abc:pa#ss@host.example:5432/postgres': /special characters/,
    'postgresql://postgres.abc:[YOUR-PASSWORD]@host.example:5432/postgres': /brackets/,
    'postgresql://postgres.abc@host.example:5432/postgres': /password is missing/,
    'postgresql://postgres.abc:postgresql://postgres.abc:pw@h.example:5432/postgres': /more than once/,
    'host.example:5432/postgres': /must start with postgresql/,
    'postgresql://postgres.abc:pw @host.example:5432/postgres': /spaces/,
  };
  for (const [raw, expected] of Object.entries(cases)) {
    assert.throws(() => parseDatabaseUrl(raw), (err) => {
      assert.match(err.message, expected);
      assert.ok(!err.message.includes(raw), 'the message must never echo the value (it holds the password)');
      return true;
    });
  }
});

test('config strips quotes and whitespace pasted around values', () => {
  assert.equal(clean('  "postgresql://u:p@h/db"\n'), 'postgresql://u:p@h/db');
  assert.equal(clean("'https://x.supabase.co'"), 'https://x.supabase.co');
  assert.equal(clean('   '), null);
});
