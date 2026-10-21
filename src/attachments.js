'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const multer = require('multer');
const { badRequest, HttpError } = require('./util');

const TYPES = {
  'application/pdf': { exts: ['.pdf'], magic: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  'image/png': { exts: ['.png'], magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/jpeg': { exts: ['.jpg', '.jpeg'], magic: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
};

const ALLOWED_DESCRIPTION = 'PDF, JPG, JPEG or PNG';

/** Detects the real type from file content; never trusts the client's MIME type. */
function detectType(buffer) {
  for (const [mime, t] of Object.entries(TYPES)) if (t.magic(buffer)) return mime;
  return null;
}

/** Keeps a display-only version of the user's filename; it is never used as a path. */
function safeDisplayName(name) {
  const base = String(name || 'file').split(/[\\/]/).pop();
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>]/g, '').trim().slice(0, 255);
  return cleaned || 'file';
}

function validateUpload(file) {
  const displayName = safeDisplayName(file.originalname);
  const ext = path.extname(displayName).toLowerCase();
  const mime = detectType(file.buffer);
  if (!mime) return { error: `"${displayName}" is not a valid ${ALLOWED_DESCRIPTION} file.` };
  if (!TYPES[mime].exts.includes(ext)) {
    return { error: `"${displayName}" has an extension that does not match its content (${mime}).` };
  }
  return { displayName, mime };
}

function createUploadMiddleware(config) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxUploadBytes, files: config.maxFilesPerUpload, fields: 10, parts: config.maxFilesPerUpload + 10 },
  }).array('files', config.maxFilesPerUpload);

  return (req, res, next) => upload(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') return next(new HttpError(413, `Each file must be at most ${Math.round(config.maxUploadBytes / 1048576)} MB.`));
      if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
        return next(badRequest(`Upload up to ${config.maxFilesPerUpload} files using the "files" field.`));
      }
      return next(badRequest('The upload could not be processed.'));
    }
    next(err);
  });
}

const STORAGE_NAME_RE = /^[a-f0-9]{48}$/;

function newStorageName() {
  return crypto.randomBytes(24).toString('hex');
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function checkName(storageName) {
  if (!STORAGE_NAME_RE.test(storageName)) throw new Error('Invalid storage name');
  return storageName;
}

/** Private files on the local disk (development, tests, or a host with a persistent disk). */
function localBackend(config) {
  fs.mkdirSync(config.uploadDir, { recursive: true, mode: 0o700 });
  const filePath = (name) => path.join(config.uploadDir, name.slice(0, 2), checkName(name));
  return {
    kind: 'local',
    async init() {},
    async put(name, buffer) {
      const p = filePath(name);
      fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
      fs.writeFileSync(p, buffer, { mode: 0o600, flag: 'wx' });
    },
    async get(name) {
      try { return fs.readFileSync(filePath(name)); } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    },
    async remove(name) {
      try { fs.unlinkSync(filePath(name)); } catch { /* already gone */ }
    },
  };
}

/**
 * Private Supabase Storage bucket, accessed only from the server with the
 * service-role key (never sent to browsers). Files are served through the
 * app's own short-lived signed links, so the bucket stays private.
 */
function supabaseBackend(config, fetchImpl = fetch) {
  const base = `${config.supabaseUrl}/storage/v1`;
  const bucket = config.supabaseBucket;
  const headers = { Authorization: `Bearer ${config.supabaseKey}`, apikey: config.supabaseKey };
  const objectPath = (name) => `${name.slice(0, 2)}/${checkName(name)}`;

  async function fail(res, what) {
    const text = await res.text().catch(() => '');
    // Never include headers (they hold the key) in errors.
    throw new Error(`Supabase Storage ${what} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }

  return {
    kind: 'supabase',
    /** Creates the private bucket on first start; ignores "already exists". */
    async init() {
      const res = await fetchImpl(`${base}/bucket`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: bucket, name: bucket, public: false, file_size_limit: config.maxUploadBytes,
          allowed_mime_types: Object.keys(TYPES) }),
      });
      if (res.ok) return;
      const text = await res.text().catch(() => '');
      if (res.status === 409 || /already exists|Duplicate/i.test(text)) return;
      throw new Error(`Supabase Storage bucket setup failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    },
    async put(name, buffer, contentType) {
      const res = await fetchImpl(`${base}/object/${bucket}/${objectPath(name)}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': contentType, 'x-upsert': 'false' },
        body: buffer,
      });
      if (!res.ok) await fail(res, 'upload');
    },
    async get(name) {
      const res = await fetchImpl(`${base}/object/authenticated/${bucket}/${objectPath(name)}`, { headers });
      if (res.status === 404 || res.status === 400) return null;
      if (!res.ok) await fail(res, 'download');
      return Buffer.from(await res.arrayBuffer());
    },
    async remove(name) {
      const res = await fetchImpl(`${base}/object/${bucket}`, {
        method: 'DELETE',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefixes: [objectPath(name)] }),
      });
      if (!res.ok && res.status !== 404) await fail(res, 'delete');
    },
  };
}

function createFileStore(config, { backend } = {}) {
  const store = backend || (config.supabaseUrl && config.supabaseKey ? supabaseBackend(config) : localBackend(config));

  /** Stores a buffer under a random server-generated name. */
  async function save(buffer, contentType) {
    const storageName = newStorageName();
    await store.put(storageName, buffer, contentType);
    return { storageName, sha256: sha256(buffer) };
  }

  async function discard(storageName) {
    try { await store.remove(storageName); } catch { /* best effort: an orphaned file is harmless */ }
  }

  // ---- Short-lived signed download links -----------------------------------

  function sign(payload) {
    return crypto.createHmac('sha256', config.downloadSecret).update(payload).digest('base64url');
  }

  function createDownloadToken(attachmentId, userId) {
    const exp = Math.floor(Date.now() / 1000) + config.downloadLinkTtlSeconds;
    const payload = Buffer.from(JSON.stringify({ a: attachmentId, u: userId, e: exp })).toString('base64url');
    return `${payload}.${sign(payload)}`;
  }

  /** Returns {attachmentId, userId} or null if the token is forged or expired. */
  function verifyDownloadToken(token) {
    if (typeof token !== 'string' || token.length > 500) return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    const expected = Buffer.from(sign(payload));
    const actual = Buffer.from(sig);
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
    try {
      const { a, u, e } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (!Number.isSafeInteger(a) || !Number.isSafeInteger(u) || e < Date.now() / 1000) return null;
      return { attachmentId: a, userId: u };
    } catch {
      return null;
    }
  }

  return {
    kind: store.kind, init: () => store.init(), save, discard,
    read: (name) => store.get(name), put: (name, buffer, type) => store.put(name, buffer, type),
    createDownloadToken, verifyDownloadToken,
  };
}

module.exports = { createUploadMiddleware, createFileStore, localBackend, supabaseBackend, validateUpload, detectType, safeDisplayName, ALLOWED_DESCRIPTION };
