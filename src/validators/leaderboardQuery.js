'use strict';

const { ValidationError } = require('../errors');
const { isValidPeriodType, PERIOD_TYPES } = require('../leaderboard/keys');

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 100;

/**
 * Validates the GET /api/leaderboard query string.
 * @returns {{ period: string, limit: number }}
 * @throws {ValidationError}
 */
function validateLeaderboardQuery(query = {}) {
  const errors = [];

  const period = query.period === undefined || query.period === '' ? PERIOD_TYPES.GLOBAL : query.period;
  if (!isValidPeriodType(period)) {
    errors.push({ field: 'period', message: 'must be one of global|daily|weekly' });
  }

  let limit = DEFAULT_LIMIT;
  if (query.limit !== undefined && query.limit !== '') {
    const n = Number(query.limit);
    if (!Number.isInteger(n) || n <= 0 || n > MAX_LIMIT) {
      errors.push({ field: 'limit', message: `must be an integer in [1, ${MAX_LIMIT}]` });
    } else {
      limit = n;
    }
  }

  if (errors.length > 0) {
    throw new ValidationError('Invalid query parameters', errors);
  }

  return { period, limit };
}

module.exports = { validateLeaderboardQuery, MAX_LIMIT, DEFAULT_LIMIT };
