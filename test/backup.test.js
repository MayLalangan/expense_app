'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const { makeApp, signUp, makeGroup, PNG } = require('./helpers');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');
const { backup } = require('../scripts/backup');
const { restore } = require('../scripts/restore');

test('backup and restore round-trip including attachments', async (t) => {
  const { app, config, cleanup } = makeApp();
  const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'expenses-backup-'));
  t.after(() => { cleanup(); fs.rmSync(backupRoot, { recursive: true, force: true }); });

  const alice = await signUp(app, 'Alice');
  const gid = await makeGroup(alice);
  const exp = (await alice.post(`/api/groups/${gid}/expenses`, { title: 'Before backup', amount: '10', expenseDate: '2026-10-01' })).body.record;
  await alice.upload(`/api/groups/${gid}/expenses/${exp.id}/attachments`, [{ buffer: PNG, name: 'r.png' }]);

  const dest = backup(config, backupRoot);
  // Changes after the backup must disappear after restore.
  await alice.post(`/api/groups/${gid}/expenses`, { title: 'After backup', amount: '20', expenseDate: '2026-10-02' });
  app.locals.db.close();

  const { movedTo } = restore(config, dest);
  assert.ok(fs.existsSync(movedTo));

  const restored = createApp({ ...loadConfig({ dataDir: config.dataDir, logRequests: false }), downloadSecret: config.downloadSecret }, { logger: { info() {}, error() {} } });
  t.after(() => restored.locals.db.close());
  const agent = request.agent(restored);
  const login = await agent.post('/api/auth/signin').send({ name: 'Alice', password: 'a-very-good-password' });
  assert.equal(login.status, 200);
  const list = await agent.get(`/api/groups/${gid}/expenses`);
  assert.deepEqual(list.body.items.map((i) => i.title), ['Before backup']);
  const detail = await agent.get(`/api/groups/${gid}/expenses/${exp.id}`);
  const link = await agent.get(`/api/groups/${gid}/expenses/${exp.id}/attachments/${detail.body.attachments[0].id}/link`);
  const file = await agent.get(link.body.url).buffer(true);
  assert.equal(file.status, 200);
  assert.ok(Buffer.compare(file.body, PNG) === 0);
  assert.ok(fs.existsSync(path.join(movedTo, 'app.db'))); // previous data kept, not deleted
});
