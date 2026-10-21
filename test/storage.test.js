'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { supabaseBackend, createFileStore } = require('../src/attachments');
const { loadConfig } = require('../src/config');

const KEY = 'service-role-key-for-tests';
const config = { supabaseUrl: 'https://proj.supabase.co', supabaseKey: KEY, supabaseBucket: 'receipts', maxUploadBytes: 10485760 };

/** A fake Supabase Storage API that records calls. */
function fakeSupabase() {
  const objects = new Map();
  const calls = [];
  let bucketExists = false;
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', headers: opts.headers, body: opts.body });
    const u = new URL(url);
    const reply = (status, body = '') => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    if (opts.headers?.Authorization !== `Bearer ${KEY}`) return reply(401, 'no auth');
    if (u.pathname === '/storage/v1/bucket' && opts.method === 'POST') {
      if (bucketExists) return reply(409, { error: 'Duplicate', message: 'The resource already exists' });
      bucketExists = true;
      return reply(200, { name: 'receipts' });
    }
    let m = /^\/storage\/v1\/object\/receipts\/(.+)$/.exec(u.pathname);
    if (m && opts.method === 'POST') { objects.set(m[1], Buffer.from(opts.body)); return reply(200, { Key: m[1] }); }
    m = /^\/storage\/v1\/object\/authenticated\/receipts\/(.+)$/.exec(u.pathname);
    if (m) return objects.has(m[1]) ? new Response(objects.get(m[1]), { status: 200 }) : reply(400, { statusCode: '404', error: 'not_found' });
    if (u.pathname === '/storage/v1/object/receipts' && opts.method === 'DELETE') {
      for (const p of JSON.parse(opts.body).prefixes) objects.delete(p);
      return reply(200, []);
    }
    return reply(404, 'unknown');
  };
  return { fetchImpl, objects, calls };
}

test('Supabase backend: private bucket setup, upload, download, delete', async () => {
  const fake = fakeSupabase();
  const store = createFileStore({ ...config, downloadSecret: 'x', downloadLinkTtlSeconds: 60 }, { backend: supabaseBackend(config, fake.fetchImpl) });
  assert.equal(store.kind, 'supabase');

  await store.init();
  await store.init(); // second start: "already exists" is fine
  const bucketCall = fake.calls.find((c) => c.url.endsWith('/bucket'));
  assert.equal(JSON.parse(bucketCall.body).public, false, 'bucket must be private');

  const content = Buffer.from('%PDF-1.4 test');
  const { storageName, sha256 } = await store.save(content, 'application/pdf');
  assert.match(storageName, /^[a-f0-9]{48}$/);
  assert.equal(sha256.length, 64);
  const upload = fake.calls.find((c) => c.method === 'POST' && c.url.includes('/object/'));
  assert.equal(upload.url, `https://proj.supabase.co/storage/v1/object/receipts/${storageName.slice(0, 2)}/${storageName}`);
  assert.equal(upload.headers['Content-Type'], 'application/pdf');
  assert.equal(upload.headers['x-upsert'], 'false');

  assert.deepEqual(await store.read(storageName), content);
  assert.equal(await store.read('0'.repeat(48)), null);
  await store.discard(storageName);
  assert.equal(await store.read(storageName), null);
  await assert.rejects(store.read('../etc/passwd'), /Invalid storage name/);
});

test('Supabase backend errors never leak the service key', async () => {
  const failing = async () => new Response('boom', { status: 500 });
  const store = supabaseBackend(config, failing);
  const err = await store.put('a'.repeat(48), Buffer.from('x'), 'image/png').catch((e) => e);
  assert.match(err.message, /HTTP 500/);
  assert.ok(!err.message.includes(KEY));
});

test('production refuses to start without durable storage', () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { NODE_ENV: 'production', DOWNLOAD_LINK_SECRET: 'x' });
    delete process.env.DATABASE_URL;
    assert.throws(() => loadConfig(), /DATABASE_URL/);
    assert.doesNotThrow(() => loadConfig({ allowLocalData: true }));
    assert.doesNotThrow(() => loadConfig({ databaseUrl: 'postgres://u:p@h/db', supabaseUrl: 'https://p.supabase.co', supabaseKey: 'k' }));
  } finally {
    process.env = saved;
  }
});
