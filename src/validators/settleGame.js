'use strict';

const { ValidationError } = require('../errors');

// RFC-4122-shaped UUID (accepts any version nibble for tolerance).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates the /api/game/settle body.
 * `result` is an OPAQUE, optional payload forwarded to the trusted resolver;
 * it is never treated as an authoritative payout. `user_id` is not read here —
 * it comes from the JWT.
 *
 * @returns {{ sessionId: string, result: object|null }}
 * @throws {ValidationError}
 */
function validateSettleGame(body = {}) {
  const errors = [];

  const sessionId = body.session_id;
  if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) {
    errors.push({ field: 'session_id', message: 'must be a valid session UUID' });
  }

  let result = null;
  if (body.result !== undefined && body.result !== null) {
    if (typeof body.result !== 'object' || Array.isArray(body.result)) {
      errors.push({ field: 'result', message: 'must be an object' });
    } else {
      result = body.result;
    }
  }

  if (errors.length > 0) {
    throw new ValidationError('Invalid request body', errors);
  }

  return { sessionId, result };
}

module.exports = { validateSettleGame };
