'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { validateLeaderboardQuery } = require('../../src/validators/leaderboardQuery');

describe('validateLeaderboardQuery', () => {
  it('defaults to global/100 when unspecified', () => {
    assert.deepEqual(validateLeaderboardQuery({}), { period: 'global', limit: 100 });
  });

  it('accepts valid period and limit', () => {
    assert.deepEqual(validateLeaderboardQuery({ period: 'daily', limit: '50' }), {
      period: 'daily',
      limit: 50,
    });
    assert.deepEqual(validateLeaderboardQuery({ period: 'weekly' }), { period: 'weekly', limit: 100 });
  });

  it('rejects invalid period and out-of-range/non-integer limits', () => {
    for (const bad of [
      { period: 'monthly' },
      { limit: '0' },
      { limit: '5000' },
      { limit: '1.5' },
      { limit: 'abc' },
    ]) {
      let err;
      try {
        validateLeaderboardQuery(bad);
      } catch (e) {
        err = e;
      }
      assert.ok(err && err.code === 'VALIDATION_ERROR', `should reject ${JSON.stringify(bad)}`);
    }
  });
});
