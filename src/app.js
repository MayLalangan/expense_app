'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { openDatabase, isConstraintError } = require('./db');
const { createAuth } = require('./auth');
const { HttpError, wrap, notFound, unauthorized, badRequest } = require('./util');
const { createFileStore, createUploadMiddleware } = require('./attachments');
const { groupsRouter } = require('./routes/groups');
const { recordsRouter } = require('./routes/records');
const { deletionsRouter } = require('./routes/deletions');
const { loadMembership } = require('./permissions');
const { dashboard } = require('./dashboard');
const { parseId } = require('./util');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function securityHeaders(config) {
  return (_req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' blob: data:; object-src 'none'; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    if (config.production) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  };
}

/** Small in-memory fixed-window limiter; good enough for a single instance. */
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const key = `${req.ip}|${req.path}`;
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || now > entry.reset) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (hits.size > 10000) for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
      return next(new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.'));
    }
    next();
  };
}

/** Rejects cross-site state-changing requests when the browser sends an Origin header. */
function sameOrigin(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin) {
    let host;
    try { host = new URL(origin).host; } catch { host = null; }
    if (host !== req.get('host')) return next(new HttpError(403, 'Cross-site request blocked.'));
  }
  next();
}

async function createApp(config, { logger = console } = {}) {
  const db = await openDatabase(config, logger);
  const auth = createAuth({ db, config });
  const fileStore = createFileStore(config);
  await fileStore.init();
  const uploadMiddleware = createUploadMiddleware(config);

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);
  app.use(securityHeaders(config));

  if (config.logRequests) {
    app.use((req, res, next) => {
      const start = Date.now();
      // Log path only (no query strings, which may contain search terms) and never tokens.
      res.on('finish', () => logger.info(`${req.method} ${req.path.replace(/^\/(files|api\/invitations)\/[^/]+/, '/$1/:token')} ${res.statusCode} ${Date.now() - start}ms`));
      next();
    });
  }

  // ?db=1 also touches the database; the scheduled keep-alive uses it so the
  // free Supabase project never counts as inactive.
  app.get('/healthz', wrap(async (req, res) => {
    if (req.query.db === '1') await db.get('SELECT COUNT(*) AS n FROM schema_migrations');
    res.set('Cache-Control', 'no-store').json({ ok: true });
  }));

  // ---- API -----------------------------------------------------------------
  const api = express.Router();
  api.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  api.use(sameOrigin);
  // Only JSON and multipart bodies are accepted; plain HTML forms from other
  // sites therefore cannot trigger state changes (complements SameSite + CSRF token).
  api.use((req, _res, next) => {
    const hasBody = Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'] !== undefined;
    if (hasBody && !req.is('application/json') && !req.is('multipart/form-data')) {
      return next(badRequest('Requests must be sent as JSON.'));
    }
    next();
  });
  api.use(express.json({ limit: '100kb' }));
  api.use(auth.loadSession);

  const authLimiter = rateLimit(config.rateLimit);
  api.post('/auth/signup', authLimiter, wrap(async (req, res) => res.status(201).json(await auth.signUp(req.body, res))));
  api.post('/auth/signin', authLimiter, wrap(async (req, res) => res.json(await auth.signIn(req.body, res))));
  api.get('/auth/me', (req, res, next) => {
    if (!req.user) return next(unauthorized(req.sessionExpired ? 'Your session has expired. Please sign in again.' : 'Not signed in.'));
    res.json({ user: req.user, csrfToken: req.csrfToken });
  });

  api.use(auth.requireUser, auth.requireCsrf);
  api.post('/auth/signout', wrap(async (req, res) => { await auth.destroySession(req, res); res.json({ ok: true }); }));

  api.get('/groups/:gid/dashboard', wrap(async (req, res) => {
    const m = await loadMembership(db, parseId(req.params.gid, 'group'), req.user.id);
    res.json(await dashboard(db, m, req.user.id));
  }));
  api.use(groupsRouter({ db, config }));
  api.use(recordsRouter({ db, config, fileStore, uploadMiddleware }));
  api.use(deletionsRouter({ db }));
  api.use((_req, _res, next) => next(notFound('Unknown API endpoint.')));
  app.use('/api', api);

  // ---- Authorized, short-lived attachment delivery -------------------------
  app.get('/files/:token', auth.loadSession, wrap(async (req, res) => {
    const t = fileStore.verifyDownloadToken(req.params.token);
    if (!t) throw notFound('This link has expired. Go back and open the file again.');
    // The link is bound to the user who requested it and re-checks membership now.
    if (!req.user || req.user.id !== t.userId) throw unauthorized('Please sign in to view this file.');
    const a = await db.get('SELECT * FROM attachments WHERE id = ?', [t.attachmentId]);
    if (!a) throw notFound();
    await loadMembership(db, a.group_id, req.user.id);
    const content = await fileStore.read(a.storage_name);
    if (!content) throw notFound('File is missing from storage.');
    const disposition = req.query.download === '1' ? 'attachment' : 'inline';
    res.set({
      'Content-Type': a.mime_type,
      'Content-Disposition': `${disposition}; filename="${a.original_name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(a.original_name)}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if (a.mime_type.startsWith('image/')) res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
    else res.removeHeader('Content-Security-Policy');
    res.send(content);
  }));

  // ---- Frontend ------------------------------------------------------------
  app.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: config.production ? '1h' : 0 }));

  // ---- Errors --------------------------------------------------------------
  app.use((err, req, res, _next) => {
    let status = err.status || err.statusCode || 500;
    let message = err.expose ? err.message : 'Something went wrong. Please try again.';
    let details = err.details;
    if (err.type === 'entity.parse.failed') { status = 400; message = 'Malformed JSON body.'; }
    if (err.type === 'entity.too.large') { status = 413; message = 'Request body is too large.'; }
    if (status === 500 && isConstraintError(err)) {
      status = 409; message = 'That change conflicts with existing data. Reload and try again.'; details = undefined;
    }
    if (status >= 500) {
      const errorId = crypto.randomBytes(6).toString('hex');
      logger.error(`[${errorId}] ${req.method} ${req.path}:`, err.stack || err);
      message = `Something went wrong (error ${errorId}). Please try again.`;
      details = undefined;
    }
    if (req.path.startsWith('/api/') || req.xhr) return res.status(status).json({ error: message, details });
    res.status(status).type('text/plain').send(message);
  });

  app.locals.db = db;
  app.locals.fileStore = fileStore;
  return app;
}

module.exports = { createApp };
