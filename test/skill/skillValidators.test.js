'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateSkillStart,
  validateSkillSubmit,
  validateSkillLeaderboardQuery,
} = require('../../src/validators/skillGame');

const UUID = '11111111-1111-4111-8111-111111111111';

describe('validateSkillStart', () => {
  it('accepts a positive game_id', () => {
    assert.deepEqual(validateSkillStart({ game_id: 7 }), { gameId: 7 });
  });
  it('rejects missing / non-positive game_id', () => {
    for (const bad of [{}, { game_id: 0 }, { game_id: -3 }, { game_id: 'x' }]) {
      assert.throws(() => validateSkillStart(bad), (e) => e.code === 'VALIDATION_ERROR');
    }
  });
});

describe('validateSkillSubmit', () => {
  it('accepts a valid body and defaults submission to {}', () => {
    assert.deepEqual(validateSkillSubmit({ session_id: UUID, seed_token: '1000.abc' }), {
      sessionId: UUID,
      seedToken: '1000.abc',
      submission: {},
    });
    assert.deepEqual(
      validateSkillSubmit({ session_id: UUID, seed_token: 't', submission: { score: 5 } }).submission,
      { score: 5 },
    );
  });
  it('rejects bad session_id, missing/blank token, array submission', () => {
    for (const bad of [
      { seed_token: 't' },
      { session_id: 'nope', seed_token: 't' },
      { session_id: UUID },
      { session_id: UUID, seed_token: '' },
      { session_id: UUID, seed_token: 't', submission: [1, 2] },
    ]) {
      assert.throws(() => validateSkillSubmit(bad), (e) => e.code === 'VALIDATION_ERROR');
    }
  });
});

describe('validateSkillLeaderboardQuery', () => {
  it('defaults limit to 100', () => {
    assert.deepEqual(validateSkillLeaderboardQuery({ game_id: 3 }), { gameId: 3, limit: 100 });
  });
  it('rejects bad game_id / limit', () => {
    for (const bad of [{}, { game_id: 3, limit: 0 }, { game_id: 3, limit: 5000 }, { game_id: 3, limit: '1.5' }]) {
      assert.throws(() => validateSkillLeaderboardQuery(bad), (e) => e.code === 'VALIDATION_ERROR');
    }
  });
});
