'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { isConstraintError } = require('./db');
const { unauthorized, forbidden, badRequest, nowIso } = require('./util');

const SESSION_COOKIE = 'sid';
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]{0,38}[\p{L}\p{N}.]$/u;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

const scrypt = promisify(crypto.scrypt);

function formatHash(salt, hash) {
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

// Async scrypt keeps the server responsive while hashing.
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return formatHash(salt, await scrypt(password, salt, SCRYPT.keylen, SCRYPT));
}

async function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p),
  });
  return crypto.timingSafeEqual(expected, actual);
}

// Used to keep sign-in timing similar whether or not the name exists.
const DUMMY_SALT = crypto.randomBytes(16);
const DUMMY_HASH = formatHash(DUMMY_SALT, crypto.scryptSync(crypto.randomBytes(16), DUMMY_SALT, SCRYPT.keylen, SCRYPT));

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

  async function createSession(res, userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const csrf = crypto.randomBytes(24).toString('base64url');
    const now = new Date();
    const ttl = hoursMs(config.sessionTtlHours);
    await db.run(`INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, last_seen_at, expires_at)
                  VALUES (?, ?, ?, ?, ?, ?)`,
    [sha256(token), userId, csrf, now.toISOString(), now.toISOString(), new Date(now.getTime() + ttl).toISOString()]);
    setCookie(res, token, ttl);
    return csrf;
  }

  async function destroySession(req, res) {
    if (req.sessionTokenHash) await db.run('DELETE FROM sessions WHERE token_hash = ?', [req.sessionTokenHash]);
    setCookie(res, '', 0);
  }

  /** Loads req.user from the session cookie; never rejects on its own. */
  async function loadSessionAsync(req, res) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return;
    const tokenHash = sha256(token);
    const row = await db.get(`SELECT s.*, u.name FROM sessions s JOIN users u ON u.id = s.user_id
                              WHERE s.token_hash = ?`, [tokenHash]);
    if (!row) {
      setCookie(res, '', 0);
      return;
    }
    const now = Date.now();
    const idleExpired = now - Date.parse(row.last_seen_at) > hoursMs(config.sessionIdleHours);
    if (now > Date.parse(row.expires_at) || idleExpired) {
      await db.run('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]);
      setCookie(res, '', 0);
      req.sessionExpired = true;
      return;
    }
    if (now - Date.parse(row.last_seen_at) > 60 * 1000) {
      await db.run('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?', [nowIso(), tokenHash]);
    }
    req.user = { id: row.user_id, name: row.name };
    req.csrfToken = row.csrf_token;
    req.sessionTokenHash = tokenHash;
  }

  function loadSession(req, res, next) {
    loadSessionAsync(req, res).then(() => next(), next);
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

  async function signUp(body, res) {
    const { name, password, errors } = validateCredentials(body);
    if (Object.keys(errors).length) throw badRequest('Please fix the highlighted fields.', errors);
    const taken = () => badRequest('That name is already taken.', { name: 'That name is already taken.' });
    if (await db.get('SELECT id FROM users WHERE lower(name) = lower(?)', [name])) throw taken();
    let id;
    try {
      id = await db.insert('INSERT INTO users (name, password_hash, created_at) VALUES (?, ?, ?)', [name, await hashPassword(password), nowIso()]);
    } catch (err) {
      if (isConstraintError(err)) throw taken(); // lost a race with an identical sign-up
      throw err;
    }
    const csrfToken = await createSession(res, id);
    return { user: { id, name }, csrfToken };
  }

  async function signIn(body, res) {
    const name = normalizeName(body?.name);
    const password = typeof body?.password === 'string' ? body.password : '';
    const row = name ? await db.get('SELECT id, name, password_hash FROM users WHERE lower(name) = lower(?)', [name]) : null;
    const ok = (await verifyPassword(password, row ? row.password_hash : DUMMY_HASH)) && !!row;
    if (!ok) throw unauthorized('Incorrect name or password.');
    const csrfToken = await createSession(res, row.id);
    return { user: { id: row.id, name: row.name }, csrfToken };
  }

  return { loadSession, requireUser, requireCsrf, signUp, signIn, destroySession };
}

module.exports = { createAuth, hashPassword, verifyPassword, sha256, normalizeName, SESSION_COOKIE };
