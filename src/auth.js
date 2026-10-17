'use strict';

const crypto = require('node:crypto');
const { unauthorized, forbidden, badRequest, nowIso } = require('./util');

const SESSION_COOKIE = 'sid';
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]{0,38}[\p{L}\p{N}.]$/u;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p),
  });
  return crypto.timingSafeEqual(expected, actual);
}

// Used to keep sign-in timing similar whether or not the name exists.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

function normalizeName(raw) {
  return typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
}

function validateCredentials(body) {
  const name = normalizeName(body?.name);
  const password = typeof body?.password === 'string' ? body.password : '';
  const errors = {};
  if (!NAME_RE.test(name)) {
    errors.name = 'Name must be 2–40 characters: letters, digits, spaces, . _ \' -';
  }
  if (password.length < 10) errors.password = 'Password must be at least 10 characters.';
  else if (password.length > 200) errors.password = 'Password is too long.';
  return { name, password, errors };
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createAuth({ db, config }) {
  const hoursMs = (h) => h * 60 * 60 * 1000;

  function setCookie(res, token, maxAgeMs) {
    const parts = [
      `${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax',
      `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    ];
    if (config.secureCookies) parts.push('Secure');
    res.append('Set-Cookie', parts.join('; '));
  }

  function createSession(res, userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const csrf = crypto.randomBytes(24).toString('base64url');
    const now = new Date();
    const ttl = hoursMs(config.sessionTtlHours);
    db.prepare(`INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, last_seen_at, expires_at)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(sha256(token), userId, csrf, now.toISOString(), now.toISOString(), new Date(now.getTime() + ttl).toISOString());
    setCookie(res, token, ttl);
    return csrf;
  }

  function destroySession(req, res) {
    if (req.sessionTokenHash) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.sessionTokenHash);
    setCookie(res, '', 0);
  }

  /** Loads req.user from the session cookie; never rejects on its own. */
  function loadSession(req, res, next) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return next();
    const tokenHash = sha256(token);
    const row = db.prepare(`SELECT s.*, u.name FROM sessions s JOIN users u ON u.id = s.user_id
                            WHERE s.token_hash = ?`).get(tokenHash);
    if (!row) {
      setCookie(res, '', 0);
      return next();
    }
    const now = Date.now();
    const idleExpired = now - Date.parse(row.last_seen_at) > hoursMs(config.sessionIdleHours);
    if (now > Date.parse(row.expires_at) || idleExpired) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
      setCookie(res, '', 0);
      req.sessionExpired = true;
      return next();
    }
    if (now - Date.parse(row.last_seen_at) > 60 * 1000) {
      db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(nowIso(), tokenHash);
    }
    req.user = { id: row.user_id, name: row.name };
    req.csrfToken = row.csrf_token;
    req.sessionTokenHash = tokenHash;
    next();
  }

  function requireUser(req, _res, next) {
    if (!req.user) {
      return next(unauthorized(req.sessionExpired ? 'Your session has expired. Please sign in again.' : undefined));
    }
    next();
  }

  /** Double-submit check for state-changing requests made with a session. */
  function requireCsrf(req, _res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (!req.user) return next();
    const sent = req.get('x-csrf-token') || '';
    const a = Buffer.from(sent);
    const b = Buffer.from(req.csrfToken);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return next(forbidden('Invalid or missing CSRF token. Reload the page and try again.'));
    }
    next();
  }

  function signUp(body, res) {
    const { name, password, errors } = validateCredentials(body);
    if (Object.keys(errors).length) throw badRequest('Please fix the highlighted fields.', errors);
    const existing = db.prepare('SELECT id FROM users WHERE name = ?').get(name);
    if (existing) throw badRequest('That name is already taken.', { name: 'That name is already taken.' });
    const { lastInsertRowid } = db.prepare('INSERT INTO users (name, password_hash, created_at) VALUES (?, ?, ?)')
      .run(name, hashPassword(password), nowIso());
    const id = Number(lastInsertRowid);
    const csrfToken = createSession(res, id);
    return { user: { id, name }, csrfToken };
  }

  function signIn(body, res) {
    const name = normalizeName(body?.name);
    const password = typeof body?.password === 'string' ? body.password : '';
    const row = name ? db.prepare('SELECT id, name, password_hash FROM users WHERE name = ?').get(name) : null;
    const ok = verifyPassword(password, row ? row.password_hash : DUMMY_HASH) && !!row;
    if (!ok) throw unauthorized('Incorrect name or password.');
    const csrfToken = createSession(res, row.id);
    return { user: { id: row.id, name: row.name }, csrfToken };
  }

  return { loadSession, requireUser, requireCsrf, signUp, signIn, destroySession };
}

module.exports = { createAuth, hashPassword, verifyPassword, sha256, normalizeName, SESSION_COOKIE };
