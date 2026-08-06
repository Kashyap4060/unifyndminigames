'use strict';

const { createHmac, timingSafeEqual } = require('crypto');

/**
 * Crypto for skill-game anti-cheat. Two independently-derived values from the
 * server secret:
 *
 *  - **seed token** (`signToken`/`verifyToken`): returned to the client at /start
 *    and echoed back at /submit. Proves the session came from us and wasn't
 *    tampered with. Safe to expose (it's a signature over public fields).
 *  - **hidden seed** (`deriveHiddenSeed`): SERVER-ONLY. Used to derive per-session
 *    game content deterministically (e.g. the Anagram letter rack) so the server
 *    can reproduce it at /submit. Never sent to the client; the client can't
 *    reproduce it without the secret.
 *
 * Both are namespaced ('proof:' vs 'hidden:') so knowing the token can never
 * reveal the hidden seed.
 */

function hmacHex(secret, message) {
  return createHmac('sha256', String(secret)).update(message).digest('hex');
}

/** Signed token = `<issuedAt>.<hmac>` over the session + issuedAt (client-visible). */
function signToken(sessionId, issuedAt, secret) {
  const sig = hmacHex(secret, `proof:${sessionId}:${issuedAt}`);
  return `${issuedAt}.${sig}`;
}

/**
 * Verify a client-echoed token against the session's stored issuedAt.
 * Timing-safe. Returns true/false.
 */
function verifyToken(sessionId, issuedAt, token, secret) {
  if (typeof token !== 'string') return false;
  const expected = signToken(sessionId, issuedAt, secret);
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Server-only hidden seed hex — never exposed to the client. */
function deriveHiddenSeed(sessionId, userId, gameId, secret) {
  return hmacHex(secret, `hidden:${sessionId}:${userId}:${gameId}`);
}

/** Deterministic non-negative integer in [0, max) from a hex seed. */
function seededInt(seedHex, max) {
  if (!Number.isInteger(max) || max <= 0) {
    throw new RangeError('max must be a positive integer');
  }
  // Use 52 bits (13 hex chars) to stay within Number.MAX_SAFE_INTEGER.
  const n = Number.parseInt(seedHex.slice(0, 13), 16);
  return n % max;
}

module.exports = { signToken, verifyToken, deriveHiddenSeed, seededInt };
