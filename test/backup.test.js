'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const { makeApp, signUp, makeGroup, PNG } = require('./helpers');
const { backup } = require('../scripts/backup');
const { restore } = require('../scripts/restore');

test('backup and restore round-trip including attachments', async (t) => {
  const source = await makeApp();
  const target = await makeApp({ downloadSecret: 'restore-test-secret' });
  const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'expenses-backup-'));
  t.after(async () => { await source.cleanup(); await target.cleanup(); fs.rmSync(backupRoot, { recursive: true, force: true }); });

  const alice = await signUp(source.app, 'Alice');
  const gid = await makeGroup(alice);
  const exp = (await alice.post(`/api/groups/${gid}/expenses`, { title: 'Before backup', amount: '10', expenseDate: '2026-10-01' })).body.record;
  await alice.upload(`/api/groups/${gid}/expenses/${exp.id}/attachments`, [{ buffer: PNG, name: 'r.png' }]);
  await alice.post(`/api/groups/${gid}/suggestions`, { itemName: 'Rice cooker' });

  const { dest, manifest } = await backup(source.config, backupRoot, { db: source.db, fileStore: source.app.locals.fileStore });
  assert.equal(manifest.files, 1);
  assert.equal(manifest.counts.expenses, 1);
  assert.deepEqual(manifest.missing, []);
  // Changes after the backup are not part of it.
  await alice.post(`/api/groups/${gid}/expenses`, { title: 'After backup', amount: '20', expenseDate: '2026-10-02' });

  const result = await restore(target.config, dest, { db: target.db, fileStore: target.app.locals.fileStore });
  assert.equal(result.files, 1);

  const agent = request.agent(target.app);
  const login = await agent.post('/api/auth/signin').send({ name: 'Alice', password: 'a-very-good-password' });
  assert.equal(login.status, 200);
  const csrf = login.body.csrfToken;
  const list = await agent.get(`/api/groups/${gid}/expenses`);
  assert.deepEqual(list.body.items.map((i) => i.title), ['Before backup']);
  const detail = await agent.get(`/api/groups/${gid}/expenses/${exp.id}`);
  assert.ok(detail.body.history.some((h) => h.action === 'attachment_added')); // audit history restored
  const link = await agent.get(`/api/groups/${gid}/expenses/${exp.id}/attachments/${detail.body.attachments[0].id}/link`);
  const file = await agent.get(link.body.url).buffer(true);
  assert.equal(file.status, 200);
  assert.ok(Buffer.compare(file.body, PNG) === 0);

  // Id sequences continue after restored rows.
  const next = await agent.post(`/api/groups/${gid}/expenses`).set('x-csrf-token', csrf).send({ title: 'New', amount: '5', expenseDate: '2026-10-03' });
  assert.equal(next.status, 201);
  assert.ok(next.body.record.id > exp.id);

  // Restoring over existing data is refused.
  await assert.rejects(restore(target.config, dest, { db: target.db, fileStore: target.app.locals.fileStore }), /already has data/);
});
