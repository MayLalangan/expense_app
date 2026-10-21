'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { makeApp, signUp, makeGroup, PNG, JPG, PDF } = require('./helpers');

test('attachments: validation, storage, authorized delivery, history', async (t) => {
  const { app, db, config, cleanup } = await makeApp();
  t.after(cleanup);
  const alice = await signUp(app, 'Alice');
  const bob = await signUp(app, 'Bob');
  const viewer = await signUp(app, 'Viewer');
  const outsider = await signUp(app, 'Outsider');
  const gid = await makeGroup(alice, [[bob, 'approver'], [viewer, 'viewer']]);
  const E = `/api/groups/${gid}/expenses`;
  const exp = (await alice.post(E, { title: 'Printer', amount: '1200', expenseDate: '2026-10-03' })).body.record;
  const U = `${E}/${exp.id}/attachments`;

  let pngId;
  await t.test('accepts multiple valid PDF/JPG/PNG files with safe storage names', async () => {
    const r = await alice.upload(U, [{ buffer: PNG, name: 'receipt.png' }, { buffer: JPG, name: 'photo.JPEG' }, { buffer: PDF, name: '../../etc/invoice.pdf' }]);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.attachments.length, 3);
    assert.equal(r.body.attachments[2].name, 'invoice.pdf');
    pngId = r.body.attachments[0].id;
    const rows = (await db.all('SELECT * FROM attachments WHERE record_id = ?', [exp.id]));
    for (const row of rows) {
      assert.match(row.storage_name, /^[a-f0-9]{48}$/);
      assert.equal(row.uploaded_by, alice.user.id);
      assert.ok(fs.existsSync(`${config.uploadDir}/${row.storage_name.slice(0, 2)}/${row.storage_name}`));
    }
  });

  await t.test('rejects disallowed types, spoofed content and mismatched extensions', async () => {
    const exe = await alice.upload(U, [{ buffer: Buffer.from('MZ\x90\x00 not a pdf'), name: 'invoice.pdf' }]);
    assert.equal(exe.status, 400);
    const html = await alice.upload(U, [{ buffer: Buffer.from('<script>alert(1)</script>'), name: 'x.html' }]);
    assert.equal(html.status, 400);
    const mismatch = await alice.upload(U, [{ buffer: PNG, name: 'receipt.pdf' }]);
    assert.equal(mismatch.status, 400);
    const none = await alice.upload(U, []);
    assert.equal(none.status, 400);
  });

  await t.test('rejects oversized files', async () => {
    const big = Buffer.concat([PDF, Buffer.alloc(config.maxUploadBytes + 1)]);
    const r = await alice.upload(U, [{ buffer: big, name: 'big.pdf' }]);
    assert.equal(r.status, 413);
  });

  await t.test('viewers and outsiders cannot upload', async () => {
    assert.equal((await viewer.upload(U, [{ buffer: PNG, name: 'a.png' }])).status, 403);
    assert.equal((await outsider.upload(U, [{ buffer: PNG, name: 'a.png' }])).status, 404);
  });

  await t.test('downloads use short-lived links bound to the member', async () => {
    const link = await viewer.get(`${U}/${pngId}/link`);
    assert.equal(link.status, 200);
    const file = await viewer.get(link.body.url).buffer(true);
    assert.equal(file.status, 200);
    assert.equal(file.headers['content-type'], 'image/png');
    assert.equal(file.headers['x-content-type-options'], 'nosniff');
    assert.match(file.headers['cache-control'], /no-store/);
    assert.ok(Buffer.compare(file.body, PNG) === 0);

    // Another user (even a member) cannot reuse someone else's link.
    assert.equal((await bob.get(link.body.url)).status, 401);
    assert.equal((await outsider.get(link.body.url)).status, 401);
    assert.equal((await outsider.get(`${U}/${pngId}/link`)).status, 404);

    // Tampered and expired tokens are rejected.
    const [payload, sig] = link.body.url.replace('/files/', '').split('.');
    assert.equal((await viewer.get(`/files/${payload}.${sig.slice(0, -2)}xx`)).status, 404);
    const realNow = Date.now;
    Date.now = () => realNow() + (config.downloadLinkTtlSeconds + 5) * 1000;
    try { assert.equal((await viewer.get(link.body.url)).status, 404); } finally { Date.now = realNow; }

    // Revoked members lose access even with a fresh link.
    const fresh = await viewer.get(`${U}/${pngId}/link`);
    await alice.post(`/api/groups/${gid}/members/${viewer.user.id}/revoke`);
    assert.equal((await viewer.get(fresh.body.url)).status, 404);
  });

  await t.test('replacing and removing keeps the old file and records history', async () => {
    const rep = await alice.upload(U, [{ buffer: PNG, name: 'receipt-v2.png' }], { replacesId: String(pngId) });
    assert.equal(rep.status, 201);
    const rm = await alice.post(`${U}/${rep.body.attachments[0].id}/remove`);
    assert.equal(rm.status, 200);

    const detail = (await alice.get(`${E}/${exp.id}`)).body;
    const old = detail.attachments.find((a) => a.id === pngId);
    assert.ok(old.removedAt);
    const v2 = detail.attachments.find((a) => a.name === 'receipt-v2.png');
    assert.equal(v2.replacesId, pngId);
    assert.ok(v2.removedAt);
    const actions = detail.history.map((h) => h.action);
    assert.ok(actions.includes('attachment_added') && actions.includes('attachment_replaced') && actions.includes('attachment_removed'));
    // History never contains storage names.
    assert.ok(!JSON.stringify(detail).includes((await db.get('SELECT storage_name FROM attachments WHERE id = ?', [pngId])).storage_name));

    // Removed files remain downloadable for history.
    const link = await alice.get(`${U}/${pngId}/link`);
    assert.equal((await alice.get(link.body.url)).status, 200);
  });

  await t.test('attachments stay available while deletion is pending and after archival', async () => {
    const dr = await alice.post(`${E}/${exp.id}/deletion-requests`, { reason: 'Duplicate' });
    const linkPending = await alice.get(`${U}/${pngId}/link`);
    assert.equal((await alice.get(linkPending.body.url)).status, 200);
    assert.equal((await alice.upload(U, [{ buffer: PNG, name: 'late.png' }])).status, 409);
    await bob.post(`/api/groups/${gid}/deletion-requests/${dr.body.deletionRequest.id}/approve`);
    const linkArchived = await bob.get(`${U}/${pngId}/link`);
    assert.equal((await bob.get(linkArchived.body.url)).status, 200);
  });
});
