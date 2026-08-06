'use strict';

const { ValidationError } = require('../errors');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TOKEN_LENGTH = 200;
const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 100;

function positiveIntField(value, field, errors) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) {
    errors.push({ field, message: 'must be a positive integer' });
    return null;
  }
  return n;
}

/** POST /api/skill/start body → { gameId }. */
function validateSkillStart(body = {}) {
  const errors = [];
  const gameId = positiveIntField(body.game_id, 'game_id', errors);
  if (errors.length > 0) throw new ValidationError('Invalid request body', errors);
  return { gameId };
}

/** POST /api/skill/submit body → { sessionId, seedToken, submission }. */
function validateSkillSubmit(body = {}) {
  const errors = [];

  const sessionId = body.session_id;
  if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) {
    errors.push({ field: 'session_id', message: 'must be a valid session UUID' });
  }

  const seedToken = body.seed_token;
  if (typeof seedToken !== 'string' || seedToken.length === 0 || seedToken.length > MAX_TOKEN_LENGTH) {
    errors.push({ field: 'seed_token', message: `must be a string of 1-${MAX_TOKEN_LENGTH} characters` });
  }

  // Opaque, engine-interpreted payload — must be a plain object.
  let submission = {};
  if (body.submission !== undefined && body.submission !== null) {
    if (typeof body.submission !== 'object' || Array.isArray(body.submission)) {
      errors.push({ field: 'submission', message: 'must be an object' });
    } else {
      submission = body.submission;
    }
  }

  if (errors.length > 0) throw new ValidationError('Invalid request body', errors);
  return { sessionId, seedToken, submission };
}

/** GET /api/skill/leaderboard query → { gameId, limit }. */
function validateSkillLeaderboardQuery(query = {}) {
  const errors = [];
  const gameId = positiveIntField(query.game_id, 'game_id', errors);

  let limit = DEFAULT_LIMIT;
  if (query.limit !== undefined && query.limit !== '') {
    const n = Number(query.limit);
    if (!Number.isInteger(n) || n <= 0 || n > MAX_LIMIT) {
      errors.push({ field: 'limit', message: `must be an integer in [1, ${MAX_LIMIT}]` });
    } else {
      limit = n;
    }
  }

  if (errors.length > 0) throw new ValidationError('Invalid query parameters', errors);
  return { gameId, limit };
}

module.exports = { validateSkillStart, validateSkillSubmit, validateSkillLeaderboardQuery };
