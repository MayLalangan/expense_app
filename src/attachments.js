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

function createFileStore(config) {
  fs.mkdirSync(config.uploadDir, { recursive: true, mode: 0o700 });

  function filePath(storageName) {
    if (!/^[a-f0-9]{48}$/.test(storageName)) throw new Error('Invalid storage name');
    return path.join(config.uploadDir, storageName.slice(0, 2), storageName);
  }

  /** Writes a buffer under a random server-generated name. */
  function save(buffer) {
    const storageName = crypto.randomBytes(24).toString('hex');
    const p = filePath(storageName);
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, buffer, { mode: 0o600, flag: 'wx' });
    return { storageName, sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
  }

  function discard(storageName) {
    try { fs.unlinkSync(filePath(storageName)); } catch { /* already gone */ }
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

  return { save, discard, filePath, createDownloadToken, verifyDownloadToken };
}

module.exports = { createUploadMiddleware, createFileStore, validateUpload, detectType, safeDisplayName, ALLOWED_DESCRIPTION };
