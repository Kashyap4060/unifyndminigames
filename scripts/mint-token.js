'use strict';

/**
 * Prints a demo JWT for a user id (default 1), signed with JWT_SECRET so the
 * backend accepts it. The `sub` claim carries the user id (JWT_USER_ID_CLAIM).
 *
 * Usage: node --env-file=.env scripts/mint-token.js [userId]
 */

const jwt = require('jsonwebtoken');

const secret = process.env.JWT_SECRET;
if (!secret) {
  // eslint-disable-next-line no-console
  console.error('JWT_SECRET is not set (run with: node --env-file=.env scripts/mint-token.js)');
  process.exit(1);
}

const userId = process.argv[2] || '1';
const claim = process.env.JWT_USER_ID_CLAIM || 'sub';
const algorithms = (process.env.JWT_ALGORITHMS || 'HS256').split(',')[0].trim();

const token = jwt.sign({ [claim]: Number(userId) }, secret, {
  algorithm: algorithms,
  expiresIn: '2h',
});

// eslint-disable-next-line no-console
console.log(token);
