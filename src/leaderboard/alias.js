'use strict';

const { createHmac } = require('crypto');

/**
 * Stable, opaque, non-reversible public alias for a user on leaderboards.
 *
 * The raw numeric user_id is the DB primary key (sequential/enumerable and an FK
 * target across the schema); exposing it alongside cumulative winnings to other
 * players is a PK-enumeration surface and an identity↔finances linkage. An
 * HMAC(secret, user_id) alias is deterministic (same user → same alias, so
 * clients can track a competitor across requests) yet cannot be reversed to the
 * user_id or enumerated without the server secret.
 *
 * @param {number|string} userId
 * @param {string} secret  Server-side secret (never exposed to clients).
 * @returns {string} e.g. 'p_a1b2c3d4e5f6'
 */
function aliasForUser(userId, secret) {
  const digest = createHmac('sha256', String(secret)).update(String(userId)).digest('hex');
  return `p_${digest.slice(0, 12)}`;
}

module.exports = { aliasForUser };
