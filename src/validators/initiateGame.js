'use strict';

const { ValidationError } = require('../errors');

// Upper bound on a single bet. Bets stay well within Number.MAX_SAFE_INTEGER so
// they are safe to handle as JS numbers; balances (which can be larger) are the
// only values handled as BigInt. Tune to product rules.
const MAX_POINTS_BET = 1_000_000_000; // 1e9
const MAX_IDEMPOTENCY_KEY_LENGTH = 64;

function toPositiveInt(value, field, errors, { max } = {}) {
  if (value === undefined || value === null || value === '') {
    errors.push({ field, message: 'is required' });
    return null;
  }
  const num = Number(value);
  // isSafeInteger also rejects large values that lose precision as a double.
  if (!Number.isSafeInteger(num) || num <= 0) {
    errors.push({ field, message: 'must be a positive integer' });
    return null;
  }
  if (max !== undefined && num > max) {
    errors.push({ field, message: `must not exceed ${max}` });
    return null;
  }
  return num;
}

/**
 * Validates and normalizes the /api/game/initiate request body.
 * `user_id` is intentionally NOT read here — it comes from the JWT.
 *
 * @returns {{ gameId: number, pointsBet: number, idempotencyKey: string|null }}
 * @throws {ValidationError}
 */
function validateInitiateGame(body = {}) {
  const errors = [];

  const gameId = toPositiveInt(body.game_id, 'game_id', errors, {
    max: Number.MAX_SAFE_INTEGER,
  });
  const pointsBet = toPositiveInt(body.points_bet, 'points_bet', errors, {
    max: MAX_POINTS_BET,
  });

  let idempotencyKey = null;
  if (body.idempotency_key !== undefined && body.idempotency_key !== null) {
    if (
      typeof body.idempotency_key !== 'string' ||
      body.idempotency_key.length === 0 ||
      body.idempotency_key.length > MAX_IDEMPOTENCY_KEY_LENGTH
    ) {
      errors.push({
        field: 'idempotency_key',
        message: `must be a string of 1-${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
      });
    } else {
      idempotencyKey = body.idempotency_key;
    }
  }

  // Optional, opaque engine init params (e.g. chambers/bullets). The engine
  // validates the specifics; here we only enforce it's a plain object.
  let params = null;
  if (body.params !== undefined && body.params !== null) {
    if (typeof body.params !== 'object' || Array.isArray(body.params)) {
      errors.push({ field: 'params', message: 'must be an object' });
    } else {
      params = body.params;
    }
  }

  if (errors.length > 0) {
    throw new ValidationError('Invalid request body', errors);
  }

  return { gameId, pointsBet, idempotencyKey, params };
}

module.exports = { validateInitiateGame, MAX_POINTS_BET };
