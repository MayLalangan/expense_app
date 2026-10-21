'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp, signUp } = require('./helpers');

test('sign-up, sign-in, sign-out and session lifecycle', async (t) => {
  const { app, db, cleanup } = await makeApp();
  t.after(cleanup);

  const alice = await signUp(app, 'Alice Smith', 'correct horse battery');
  assert.equal(alice.user.name, 'Alice Smith');
  const cookie = (await request(app).post('/api/auth/signin').send({ name: 'alice smith', password: 'correct horse battery' })).headers['set-cookie'][0];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);

  // Password is stored hashed.
  const row = (await db.get('SELECT password_hash FROM users WHERE id = ?', [alice.user.id]));
  assert.match(row.password_hash, /^scrypt\$/);
  assert.ok(!row.password_hash.includes('correct horse'));

  const me = await alice.get('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.name, 'Alice Smith');

  await t.test('names are unique case-insensitively', async () => {
    const r = await request(app).post('/api/auth/signup').send({ name: 'ALICE SMITH', password: 'another password' });
    assert.equal(r.status, 400);
    assert.ok(r.body.details.name);
  });

  await t.test('validates name and password', async () => {
    const r = await request(app).post('/api/auth/signup').send({ name: 'x', password: 'short' });
    assert.equal(r.status, 400);
    assert.ok(r.body.details.name && r.body.details.password);
  });

  await t.test('wrong password and unknown name give the same error', async () => {
    const a = await request(app).post('/api/auth/signin').send({ name: 'Alice Smith', password: 'wrong password!!' });
    const b = await request(app).post('/api/auth/signin').send({ name: 'Nobody Here', password: 'wrong password!!' });
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.equal(a.body.error, b.body.error);
  });

  await t.test('state-changing requests require the CSRF token', async () => {
    const r = await alice.agent.post('/api/groups').send({ name: 'No token' });
    assert.equal(r.status, 403);
    const ok = await alice.post('/api/groups', { name: 'With token' });
    assert.equal(ok.status, 201);
  });

  await t.test('cross-origin and non-JSON writes are rejected', async () => {
    const cross = await alice.agent.post('/api/groups').set('x-csrf-token', alice.csrf).set('Origin', 'https://evil.example').send({ name: 'x' });
    assert.equal(cross.status, 403);
    const form = await alice.agent.post('/api/groups').set('x-csrf-token', alice.csrf).type('form').send('name=x');
    assert.equal(form.status, 400);
  });

  await t.test('unauthenticated requests are rejected', async () => {
    const r = await request(app).get('/api/groups');
    assert.equal(r.status, 401);
  });

  await t.test('expired sessions are rejected with a clear message', async () => {
    const bob = await signUp(app, 'Bob');
    (await db.run(`UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE user_id = ?`, [bob.user.id]));
    const r = await bob.get('/api/groups');
    assert.equal(r.status, 401);
    assert.match(r.body.error, /expired/);
  });

  await t.test('idle sessions expire', async () => {
    const carol = await signUp(app, 'Carol');
    (await db.run(`UPDATE sessions SET last_seen_at = '2000-01-01T00:00:00.000Z' WHERE user_id = ?`, [carol.user.id]));
    assert.equal((await carol.get('/api/groups')).status, 401);
  });

  await t.test('sign-out destroys the session server-side', async () => {
    const r = await alice.post('/api/auth/signout');
    assert.equal(r.status, 200);
    assert.equal((await alice.get('/api/auth/me')).status, 401);
  });
});

test('sign-in is rate limited', async (t) => {
  const { app, cleanup } = await makeApp({ rateLimit: { windowMs: 60000, max: 3 } });
  t.after(cleanup);
  const statuses = [];
  for (let i = 0; i < 5; i++) {
    statuses.push((await request(app).post('/api/auth/signin').send({ name: 'Someone', password: 'whatever-password' })).status);
  }
  assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
});

test('security headers are set', async (t) => {
  const { app, cleanup } = await makeApp();
  t.after(cleanup);
  const r = await request(app).get('/');
  assert.match(r.headers['content-security-policy'], /default-src 'self'/);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['x-powered-by'], undefined);
});
