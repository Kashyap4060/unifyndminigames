'use strict';

const { ValidationError } = require('../errors');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ACTION_LENGTH = 32;

/**
 * Validates the /api/game/process body. `action` is a generic string the engine
 * interprets (e.g. 'pull', 'cashout'); `payload` is an opaque, untrusted object
 * forwarded to the engine. `user_id` comes from the JWT, not the body.
 *
 * @returns {{ sessionId: string, action: string, payload: object|null }}
 * @throws {ValidationError}
 */
function validateProcessGame(body = {}) {
  const errors = [];

  const sessionId = body.session_id;
  if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) {
    errors.push({ field: 'session_id', message: 'must be a valid session UUID' });
  }

  const action = body.action;
  if (typeof action !== 'string' || action.length === 0 || action.length > MAX_ACTION_LENGTH) {
    errors.push({ field: 'action', message: `must be a string of 1-${MAX_ACTION_LENGTH} characters` });
  }

  let payload = null;
  if (body.payload !== undefined && body.payload !== null) {
    if (typeof body.payload !== 'object' || Array.isArray(body.payload)) {
      errors.push({ field: 'payload', message: 'must be an object' });
    } else {
      payload = body.payload;
    }
  }

  if (errors.length > 0) {
    throw new ValidationError('Invalid request body', errors);
  }

  return { sessionId, action, payload };
}

module.exports = { validateProcessGame };
