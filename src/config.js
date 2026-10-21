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

  // Optional PEM certificate; "\n" escapes allow pasting it into a single-line env var.
  const caCert = (overrides.databaseCaCert ?? env.DATABASE_CA_CERT ?? '').replace(/\\n/g, '\n').trim();
  const databaseUrl = overrides.databaseUrl ?? (env.DATABASE_URL || null);
  const supabaseUrl = overrides.supabaseUrl ?? (env.SUPABASE_URL || null);
  const supabaseKey = overrides.supabaseKey ?? (env.SUPABASE_SERVICE_ROLE_KEY || null);
  const allowLocalData = overrides.allowLocalData ?? bool(env.ALLOW_LOCAL_DATA, false);

  // On hosts like Render's free tier the local disk is wiped on every restart,
  // so production refuses to start with local-only storage unless told otherwise.
  if (production && !allowLocalData && (!databaseUrl || !supabaseUrl || !supabaseKey)) {
    throw new Error('Production needs DATABASE_URL, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY '
      + '(or ALLOW_LOCAL_DATA=true on a host with a persistent disk).');
  }

  return {
    production,
    port: int(env.PORT, 3000),
    trustProxy: bool(env.TRUST_PROXY, false),
    dataDir,
    databaseUrl,
    databaseCaCert: caCert || null,
    databaseSsl: overrides.databaseSsl ?? bool(env.DATABASE_SSL, true),
    databasePoolSize: int(env.DATABASE_POOL_SIZE, 5),
    // Local Postgres (PGlite) used when DATABASE_URL is not set.
    pgliteDir: overrides.pgliteDir || path.join(dataDir, 'pgdata'),
    supabaseUrl: supabaseUrl ? supabaseUrl.replace(/\/+$/, '') : null,
    supabaseKey,
    supabaseBucket: overrides.supabaseBucket || env.SUPABASE_BUCKET || 'receipts',
    uploadDir: overrides.uploadDir || path.join(dataDir, 'uploads'),
    // Legacy SQLite file from before the move to Postgres (read by the import script).
    legacySqlitePath: path.join(dataDir, 'app.db'),
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
