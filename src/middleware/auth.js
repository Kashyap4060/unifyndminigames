'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config');
const { AuthError } = require('../errors');

/**
 * Verifies the JWT the mobile app injects into the WebView request and derives
 * the authoritative user_id from it.
 *
 * SECURITY: the acting user is taken ONLY from the verified token claim, never
 * from the request body — a client cannot bet against another user's balance.
 */
function authenticate(req, _res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return next(new AuthError('Missing or malformed Authorization header'));
  }

  let payload;
  try {
    // Pin the accepted algorithms — never trust the alg declared in the token.
    payload = jwt.verify(token, config.jwt.secret, { algorithms: config.jwt.algorithms });
  } catch (_err) {
    // Do not echo the underlying jwt error (expired vs malformed) to the client.
    return next(new AuthError('Invalid or expired token'));
  }

  // Accept the id claim only as a clean digit string / integer. parseInt would
  // silently truncate values like "12abc" -> 12; require an exact match instead.
  const rawUserId = payload[config.jwt.userIdClaim];
  const asString = typeof rawUserId === 'number' ? String(rawUserId) : rawUserId;
  if (typeof asString !== 'string' || !/^\d+$/.test(asString)) {
    return next(new AuthError('Token does not contain a valid user identifier'));
  }
  const userId = Number(asString);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    return next(new AuthError('Token does not contain a valid user identifier'));
  }

  req.auth = { userId };
  return next();
}

module.exports = authenticate;
