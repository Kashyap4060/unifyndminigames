'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const PenaltyShootoutEngine = require('../../src/engines/penaltyShootout');
const { ValidationError, ConflictError } = require('../../src/errors');
const { BPS_SCALE, payoutWithEdge } = require('../../src/engines/payout');

test('Penalty Shootout Engine', async (t) => {
  await t.test('initiate with default zones', () => {
    let goalieZoneValue;
    const engine = new PenaltyShootoutEngine({
      pickDive: (zones) => {
        goalieZoneValue = 1;
        return goalieZoneValue;
      },
    });

    const metadata = engine.initiate({});

    assert.equal(metadata.zones, 3, 'default zones should be 3');
    assert.equal(metadata.goalieZone, 1, 'goalie zone should be picked');
    assert.equal(metadata.outcome, 'IN_PROGRESS', 'initial outcome should be IN_PROGRESS');
  });

  await t.test('initiate with custom zones param', () => {
    const engine = new PenaltyShootoutEngine({
      pickDive: (zones) => 2,
    });

    const metadata = engine.initiate({ params: { zones: 5 } });

    assert.equal(metadata.zones, 5, 'zones should match param');
    assert.equal(metadata.goalieZone, 2, 'goalie zone should be picked');
    assert.equal(metadata.outcome, 'IN_PROGRESS');
  });

  await t.test('initiate validation: zones too low', () => {
    const engine = new PenaltyShootoutEngine();

    assert.throws(
      () => engine.initiate({ params: { zones: 1 } }),
      ValidationError,
      'should throw ValidationError for zones < MIN_ZONES',
    );
  });

  await t.test('initiate validation: zones too high', () => {
    const engine = new PenaltyShootoutEngine();

    assert.throws(
      () => engine.initiate({ params: { zones: 7 } }),
      ValidationError,
      'should throw ValidationError for zones > MAX_ZONES',
    );
  });

  await t.test('initiate validation: zones not integer', () => {
    const engine = new PenaltyShootoutEngine();

    assert.throws(
      () => engine.initiate({ params: { zones: 3.5 } }),
      ValidationError,
      'should throw ValidationError for non-integer zones',
    );
  });

  await t.test('processStep: goal/WIN scenario (zones=3, multiplier=1.5)', () => {
    const engine = new PenaltyShootoutEngine({
      pickDive: () => 1, // goalie dives zone 1
    });

    const metadata = engine.initiate({});
    const result = engine.processStep({
      metadata,
      action: 'shoot',
      payload: { zone: 0 }, // player shoots zone 0, different from 1
    });

    assert.equal(result.status, 'WIN', 'status should be WIN');
    assert.equal(result.metadata.outcome, 'WON', 'outcome should be WON');
    assert.equal(result.result.goal, true, 'goal should be true');
    assert.equal(result.result.goalieZone, 1, 'goalieZone should be revealed');
    assert.equal(result.metadata.multiplierBps, 15000, 'multiplier BPS should be 15000 (1.5x)');
    assert.equal(result.result.multiplier, 1.5, 'multiplier should be 1.5');
  });

  await t.test('settle: WIN with zones=3, bet=10', () => {
    const engine = new PenaltyShootoutEngine({
      pickDive: () => 1,
    });

    const metadata = engine.initiate({});
    const step = engine.processStep({
      metadata,
      action: 'shoot',
      payload: { zone: 0 },
    });

    const session = { pointsBet: 10 };
    const payout = engine.settle({ session, metadata: step.metadata });

    // Expected: floor(10 * 15000 * 9700 / (10000 * 10000)) = floor(14.55) = 14
    const expected = payoutWithEdge(10, 15000);
    assert.equal(payout, expected, `payout should be ${expected}`);
    assert.equal(payout, 14, 'payout should be 14');
  });

  await t.test('processStep: save/LOSE scenario (zones=3)', () => {
    const engine = new PenaltyShootoutEngine({
      pickDive: () => 1, // goalie dives zone 1
    });

    const metadata = engine.initiate({});
    const result = engine.processStep({
      metadata,
      action: 'shoot',
      payload: { zone: 1 }, // player shoots zone 1, same as goalie
    });

    assert.equal(result.status, 'LOSE', 'status should be LOSE');
    assert.equal(result.metadata.outcome, 'LOST', 'outcome should be LOST');
    assert.equal(result.result.goal, false, 'goal should be false');
    assert.equal(result.result.goalieZone, 1, 'goalieZone should be revealed');
    assert.equal(result.metadata.multiplierBps, 0, 'multiplier BPS should be 0 on save');
    assert.equal(result.result.multiplier, 0, 'multiplier should be 0');
  });

  await t.test('settle: LOSE returns 0', () => {
    const engine = new PenaltyShootoutEngine({
      pickDive: () => 1,
    });

    const metadata = engine.initiate({});
    const step = engine.processStep({
      metadata,
      action: 'shoot',
      payload: { zone: 1 },
    });

    const session = { pointsBet: 100 };
    const payout = engine.settle({ session, metadata: step.metadata });

    assert.equal(payout, 0, 'payout should be 0 on loss');
  });

  await t.test('zones=4: WIN with correct multiplier', () => {
    const engine = new PenaltyShootoutEngine({
      pickDive: () => 1,
    });

    const metadata = engine.initiate({ params: { zones: 4 } });
    const result = engine.processStep({
      metadata,
      action: 'shoot',
      payload: { zone: 0 },
    });

    // zones=4 → floor(4 * 10000 / 3) = floor(13333.33) = 13333
    assert.equal(result.metadata.multiplierBps, 13333, 'multiplier BPS should be 13333 for zones=4');
    assert.equal(result.result.multiplier, 1.3333, 'multiplier should be 1.3333');

    const session = { pointsBet: 10 };
    const payout = engine.settle({ session, metadata: result.metadata });
    const expected = payoutWithEdge(10, 13333);
    assert.equal(payout, expected, `payout should be ${expected}`);
  });

  await t.test('zones=2 edge case: WIN with 2x multiplier', () => {
    const engine = new PenaltyShootoutEngine({
      pickDive: () => 0,
    });

    const metadata = engine.initiate({ params: { zones: 2 } });
    const result = engine.processStep({
      metadata,
      action: 'shoot',
      payload: { zone: 1 },
    });

    // zones=2 → floor(2 * 10000 / 1) = 20000 = 2.0x
    assert.equal(result.metadata.multiplierBps, 20000, 'multiplier BPS should be 20000 for zones=2');
    assert.equal(result.result.multiplier, 2, 'multiplier should be 2');
  });

  await t.test('processStep: invalid action', () => {
    const engine = new PenaltyShootoutEngine({
      pickDive: () => 1,
    });

    const metadata = engine.initiate({});

    assert.throws(
      () => engine.processStep({
        metadata,
        action: 'invalid',
        payload: { zone: 0 },
      }),
      ValidationError,
      'should throw ValidationError for unknown action',
    );
  });

  await t.test('processStep: invalid zone (too high)', () => {
    const engine = new PenaltyShootoutEngine({
      pickDive: () => 1,
    });

    const metadata = engine.initiate({});

    assert.throws(
      () => engine.processStep({
        metadata,
        action: 'shoot',
        payload: { zone: 3 }, // zones=3, so valid range is [0, 2]
      }),
      ValidationError,
      'should throw ValidationError for zone >= zones',
    );
  });

  await t.test('processStep: invalid zone (negative)', () => {
    const engine = new PenaltyShootoutEngine({
      pickDive: () => 1,
    });

    const metadata = engine.initiate({});

    assert.throws(
      () => engine.processStep({
        metadata,
        action: 'shoot',
        payload: { zone: -1 },
      }),
      ValidationError,
      'should throw ValidationError for negative zone',
    );
  });

  await t.test('processStep: invalid zone (float)', () => {
    const engine = new PenaltyShootoutEngine({
      pickDive: () => 1,
    });

    const metadata = engine.initiate({});

    assert.throws(
      () => engine.processStep({
        metadata,
        action: 'shoot',
        payload: { zone: 1.5 },
      }),
      ValidationError,
      'should throw ValidationError for non-integer zone',
    );
  });

  await t.test('processStep: missing zone payload', () => {
    const engine = new PenaltyShootoutEngine({
      pickDive: () => 1,
    });

    const metadata = engine.initiate({});

    assert.throws(
      () => engine.processStep({
        metadata,
        action: 'shoot',
        payload: {},
      }),
      ValidationError,
      'should throw ValidationError for missing zone',
    );
  });

  await t.test('processStep: null metadata', () => {
    const engine = new PenaltyShootoutEngine();

    assert.throws(
      () => engine.processStep({
        metadata: null,
        action: 'shoot',
        payload: { zone: 0 },
      }),
      ConflictError,
      'should throw ConflictError for null metadata',
    );
  });

  await t.test('processStep: game already over', () => {
    const engine = new PenaltyShootoutEngine({
      pickDive: () => 1,
    });

    const metadata = engine.initiate({});
    const step = engine.processStep({
      metadata,
      action: 'shoot',
      payload: { zone: 0 },
    });

    assert.throws(
      () => engine.processStep({
        metadata: step.metadata, // step.metadata has outcome='WON'
        action: 'shoot',
        payload: { zone: 2 },
      }),
      ConflictError,
      'should throw ConflictError when game is already over',
    );
  });

  await t.test('result keys: exactly goal, goalieZone, multiplier', () => {
    const engine = new PenaltyShootoutEngine({
      pickDive: () => 1,
    });

    const metadata = engine.initiate({});
    const step = engine.processStep({
      metadata,
      action: 'shoot',
      payload: { zone: 0 },
    });

    const resultKeys = Object.keys(step.result).sort();
    const expectedKeys = ['goal', 'goalieZone', 'multiplier'].sort();

    assert.deepEqual(resultKeys, expectedKeys, 'result should have exactly these keys');
  });

  await t.test('settle: null metadata returns 0', () => {
    const engine = new PenaltyShootoutEngine();

    const payout = engine.settle({ session: { pointsBet: 100 }, metadata: null });
    assert.equal(payout, 0, 'settle with null metadata should return 0');
  });

  await t.test('settle: IN_PROGRESS outcome returns 0', () => {
    const engine = new PenaltyShootoutEngine();

    const metadata = {
      goalieZone: 1,
      zones: 3,
      outcome: 'IN_PROGRESS',
      multiplierBps: 15000,
    };

    const payout = engine.settle({ session: { pointsBet: 100 }, metadata });
    assert.equal(payout, 0, 'settle with IN_PROGRESS outcome should return 0');
  });
});
