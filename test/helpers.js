'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');

const silentLogger = { info() {}, error() {}, warn() {} };

function makeApp(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expenses-test-'));
  const config = { ...loadConfig({ dataDir: dir, logRequests: false, rateLimit: { windowMs: 60000, max: 1000 } }), ...overrides };
  const app = createApp(config, { logger: silentLogger });
  return { app, db: app.locals.db, config, dir, cleanup: () => { try { app.locals.db.close(); } catch { /* already closed */ } fs.rmSync(dir, { recursive: true, force: true }); } };
}

/** Signs up a user and returns a small client that sends the CSRF token automatically. */
async function signUp(app, name, password = 'a-very-good-password') {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/signup').send({ name, password });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  return client(agent, res.body.user, res.body.csrfToken);
}

function client(agent, user, csrf) {
  const withCsrf = (r) => r.set('x-csrf-token', csrf);
  return {
    agent,
    user,
    csrf,
    get: (url) => agent.get(url),
    post: (url, body) => withCsrf(agent.post(url)).send(body ?? {}),
    patch: (url, body) => withCsrf(agent.patch(url)).send(body ?? {}),
    upload: (url, files, fields = {}) => {
      let r = withCsrf(agent.post(url));
      for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
      for (const f of files) r = r.attach('files', f.buffer, f.name);
      return r;
    },
  };
}

/** Creates a group owned by `owner` and adds the other users with the given roles. */
async function makeGroup(owner, members = [], name = 'Household') {
  const res = await owner.post('/api/groups', { name, currency: 'PHP' });
  if (res.status !== 201) throw new Error(`group failed: ${res.status} ${JSON.stringify(res.body)}`);
  const gid = res.body.group.id;
  for (const [c, role] of members) {
    const r = await owner.post(`/api/groups/${gid}/members`, { name: c.user.name, role });
    if (r.status !== 201) throw new Error(`add member failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return gid;
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

module.exports = { makeApp, signUp, makeGroup, PNG, JPG, PDF };
