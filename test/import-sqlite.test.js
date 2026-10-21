'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const request = require('supertest');
const { makeApp, PNG } = require('./helpers');
const { hashPassword } = require('../src/auth');
const { importSqlite } = require('../scripts/import-sqlite');

test('imports data and receipts from the old SQLite version', async (t) => {
  const { app, db, config, cleanup } = await makeApp();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expenses-legacy-'));
  t.after(async () => { await cleanup(); fs.rmSync(dir, { recursive: true, force: true }); });

  // Build a legacy database with the final SQLite schema.
  const file = path.join(dir, 'app.db');
  const lite = new DatabaseSync(file);
  lite.exec(fs.readFileSync(path.join(__dirname, 'fixtures', 'legacy-sqlite-schema.sql'), 'utf8'));
  const now = '2026-10-17T08:00:00.000Z';
  const storage = 'ab'.repeat(24);
  lite.exec(`INSERT INTO schema_migrations VALUES (1, 'initial schema', '${now}'), (2, 'php', '${now}'), (3, 'checklist', '${now}')`);
  lite.prepare('INSERT INTO users (id, name, password_hash, created_at) VALUES (1, ?, ?, ?)').run('May', await hashPassword('legacy-password-1'), now);
  lite.exec(`
    INSERT INTO groups (id, name, currency, created_by, created_at) VALUES (1, 'Home', 'PHP', 1, '${now}');
    INSERT INTO memberships (group_id, user_id, role, created_at, updated_at) VALUES (1, 1, 'admin', '${now}', '${now}');
    INSERT INTO expenses (id, group_id, title, amount_minor, expense_date, category, created_by, created_at, updated_by, updated_at)
      VALUES (7, 1, 'Groceries', 125050, '2026-10-16', 'Food', 1, '${now}', 1, '${now}');
    INSERT INTO suggested_purchases (id, group_id, item_name, purchase_status, created_by, created_at, updated_by, updated_at)
      VALUES (3, 1, 'Rice cooker', 'suggested', 1, '${now}', 1, '${now}');
    INSERT INTO attachments (id, group_id, record_type, record_id, original_name, storage_name, mime_type, size_bytes, sha256, uploaded_by, uploaded_at)
      VALUES (1, 1, 'expense', 7, 'receipt.png', '${storage}', 'image/png', ${PNG.length}, 'x', 1, '${now}');
    INSERT INTO audit_log (group_id, actor_id, action, record_type, record_id, details, created_at)
      VALUES (1, 1, 'created', 'expense', 7, '{"values":{"title":"Groceries"}}', '${now}');`);
  lite.close();
  const uploads = path.join(dir, 'uploads');
  fs.mkdirSync(path.join(uploads, 'ab'), { recursive: true });
  fs.writeFileSync(path.join(uploads, 'ab', storage), PNG);

  const result = await importSqlite(config, file, uploads, { db, fileStore: app.locals.fileStore });
  assert.equal(result.counts.expenses, 1);
  assert.equal(result.files, 1);

  // The old account still signs in, and the data, history and receipt are all there.
  const agent = request.agent(app);
  const login = await agent.post('/api/auth/signin').send({ name: 'may', password: 'legacy-password-1' });
  assert.equal(login.status, 200);
  const dash = (await agent.get('/api/groups/1/dashboard')).body;
  assert.equal(dash.expenseTotalMinor, 125050);
  assert.equal(dash.suggestionCount, 1);
  const detail = (await agent.get('/api/groups/1/expenses/7')).body;
  assert.equal(detail.history[0].action, 'created');
  const link = await agent.get(`/api/groups/1/expenses/7/attachments/${detail.attachments[0].id}/link`);
  const png = await agent.get(link.body.url).buffer(true);
  assert.ok(Buffer.compare(png.body, PNG) === 0);

  // New records get fresh ids after the imported ones.
  const created = await agent.post('/api/groups/1/expenses').set('x-csrf-token', login.body.csrfToken)
    .send({ title: 'New', amount: '1', expenseDate: '2026-10-19' });
  assert.equal(created.body.record.id, 8);

  // A second import is refused (target no longer empty).
  await assert.rejects(importSqlite(config, file, uploads, { db, fileStore: app.locals.fileStore }), /already has data/);
});
