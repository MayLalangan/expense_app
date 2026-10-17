'use strict';

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
    this.expose = true;
  }
}

const badRequest = (msg, details) => new HttpError(400, msg, details);
const unauthorized = (msg = 'Please sign in.') => new HttpError(401, msg);
const forbidden = (msg = 'You do not have permission to do that.') => new HttpError(403, msg);
// 404 is also used for records in other groups so their existence is not revealed.
const notFound = (msg = 'Not found.') => new HttpError(404, msg);
const conflict = (msg, details) => new HttpError(409, msg, details);

/** Server-generated UTC timestamp with millisecond precision. */
function nowIso() {
  return new Date().toISOString();
}

/** Wraps a handler so thrown errors and rejected promises reach the error middleware. */
function wrap(fn) {
  return (req, res, next) => {
    try {
      const result = fn(req, res, next);
      if (result && typeof result.then === 'function') result.catch(next);
    } catch (err) {
      next(err);
    }
  };
}

function parseId(value, label = 'id') {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw notFound(`Unknown ${label}.`);
  return n;
}

module.exports = { HttpError, badRequest, unauthorized, forbidden, notFound, conflict, nowIso, wrap, parseId };
