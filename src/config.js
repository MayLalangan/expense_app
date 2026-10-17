'use strict';

const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Builds the runtime configuration from environment variables.
 * `overrides` is used by tests to point at temporary directories.
 */
function loadConfig(overrides = {}) {
  const env = process.env;
  const production = env.NODE_ENV === 'production';
  const dataDir = overrides.dataDir || path.resolve(env.DATA_DIR || path.join(ROOT, 'data'));

  let downloadSecret = overrides.downloadSecret || env.DOWNLOAD_LINK_SECRET;
  if (!downloadSecret) {
    if (production) {
      throw new Error('DOWNLOAD_LINK_SECRET must be set in production (32+ random bytes).');
    }
    // Development fallback: links simply stop working after a restart.
    downloadSecret = crypto.randomBytes(32).toString('hex');
  }

  return {
    production,
    port: int(env.PORT, 3000),
    trustProxy: bool(env.TRUST_PROXY, false),
    dataDir,
    dbPath: overrides.dbPath || path.join(dataDir, 'app.db'),
    uploadDir: overrides.uploadDir || path.join(dataDir, 'uploads'),
    secureCookies: overrides.secureCookies ?? bool(env.COOKIE_SECURE, production),
    sessionTtlHours: int(env.SESSION_TTL_HOURS, 24 * 7),
    sessionIdleHours: int(env.SESSION_IDLE_HOURS, 48),
    downloadSecret,
    downloadLinkTtlSeconds: int(env.DOWNLOAD_LINK_TTL_SECONDS, 300),
    maxUploadBytes: int(env.MAX_UPLOAD_MB, 10) * 1024 * 1024,
    maxFilesPerUpload: 10,
    invitationTtlDays: int(env.INVITATION_TTL_DAYS, 14),
    rateLimit: overrides.rateLimit ?? {
      windowMs: 15 * 60 * 1000,
      max: int(env.AUTH_RATE_LIMIT, 20),
    },
    logRequests: overrides.logRequests ?? bool(env.LOG_REQUESTS, production),
  };
}

module.exports = { loadConfig, ROOT };
