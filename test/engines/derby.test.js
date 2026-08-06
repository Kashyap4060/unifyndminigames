'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const DerbyEngine = require('../../src/engines/derby');
const { ValidationError, ConflictError } = require('../../src/errors');
const { BPS_SCALE, payoutWithEdge } = require('../../src/engines/payout');

test('Derby Engine', async (t) => {
  await t.test('initiate with default racers', () => {
    const engine = new DerbyEngine({ pickWinner: () => 3 });
    const metadata = engine.initiate();

    assert.strictEqual(typeof metadata, 'object');
    assert.strictEqual(metadata.winner, 3);
    assert.strictEqual(metadata.racers, 6);
    assert.strictEqual(metadata.outcome, 'IN_PROGRESS');
  });

  await t.test('initiate with custom racers via params', () => {
    const engine = new DerbyEngine({ pickWinner: (racers) => racers - 1 });
    const metadata = engine.initiate({ params: { racers: 10 } });

    assert.strictEqual(metadata.winner, 9);
    assert.strictEqual(metadata.racers, 10);
    assert.strictEqual(metadata.outcome, 'IN_PROGRESS');
  });

  await t.test('initiate validation: racers < MIN_RACERS throws ValidationError', () => {
    const engine = new DerbyEngine();

    assert.throws(
      () => engine.initiate({ params: { racers: 1 } }),
      (err) => err instanceof ValidationError && err.message.includes('integer in [2, 12]'),
    );
  });

  await t.test('initiate validation: racers > MAX_RACERS throws ValidationError', () => {
    const engine = new DerbyEngine();

    assert.throws(
      () => engine.initiate({ params: { racers: 13 } }),
      (err) => err instanceof ValidationError && err.message.includes('integer in [2, 12]'),
    );
  });

  await t.test('initiate validation: racers not integer throws ValidationError', () => {
    const engine = new DerbyEngine();

    assert.throws(
      () => engine.initiate({ params: { racers: 5.5 } }),
      ValidationError,
    );
  });

  await t.test('processStep WIN case', () => {
    const engine = new DerbyEngine({ pickWinner: () => 3 });
    const metadata = engine.initiate({ params: { racers: 6 } });

    const result = engine.processStep({
      metadata,
      action: 'bet',
      payload: { racer: 3 },
    });

    assert.strictEqual(result.status, 'WIN');
    assert.strictEqual(result.result.win, true);
    assert.strictEqual(result.result.winner, 3);
    assert.strictEqual(result.result.multiplier, 6);
    assert.strictEqual(result.metadata.outcome, 'WON');
    assert.strictEqual(result.metadata.multiplierBps, 6 * BPS_SCALE);
  });

  await t.test('processStep LOSE case', () => {
    const engine = new DerbyEngine({ pickWinner: () => 3 });
    const metadata = engine.initiate({ params: { racers: 6 } });

    const result = engine.processStep({
      metadata,
      action: 'bet',
      payload: { racer: 0 },
    });

    assert.strictEqual(result.status, 'LOSE');
    assert.strictEqual(result.result.win, false);
    assert.strictEqual(result.result.winner, 3);
    assert.strictEqual(result.result.multiplier, 0);
    assert.strictEqual(result.metadata.outcome, 'LOST');
    assert.strictEqual(result.metadata.multiplierBps, 0);
  });

  await t.test('settle with WON outcome returns correct payout', () => {
    const engine = new DerbyEngine({ pickWinner: () => 3 });
    const metadata = engine.initiate({ params: { racers: 6 } });
    const stepResult = engine.processStep({
      metadata,
      action: 'bet',
      payload: { racer: 3 },
    });

    const session = { pointsBet: 10 };
    const payout = engine.settle({ session, metadata: stepResult.metadata });

    // Expected: floor(10 * 6 * 10000 * 9700 / (10000 * 10000)) = floor(58.2) = 58
    const expected = payoutWithEdge(10, 6 * BPS_SCALE);
    assert.strictEqual(payout, expected);
    assert.strictEqual(payout, 58);
  });

  await t.test('settle with LOST outcome returns 0', () => {
    const engine = new DerbyEngine({ pickWinner: () => 3 });
    const metadata = engine.initiate({ params: { racers: 6 } });
    const stepResult = engine.processStep({
      metadata,
      action: 'bet',
      payload: { racer: 0 },
    });

    const session = { pointsBet: 10 };
    const payout = engine.settle({ session, metadata: stepResult.metadata });

    assert.strictEqual(payout, 0);
  });

  await t.test('settle with null metadata returns 0', () => {
    const engine = new DerbyEngine();

    const payout = engine.settle({ session: { pointsBet: 10 }, metadata: null });

    assert.strictEqual(payout, 0);
  });

  await t.test('processStep validation: invalid action throws ValidationError', () => {
    const engine = new DerbyEngine({ pickWinner: () => 3 });
    const metadata = engine.initiate({ params: { racers: 6 } });

    assert.throws(
      () => engine.processStep({
        metadata,
        action: 'invalid',
        payload: { racer: 0 },
      }),
      (err) => err instanceof ValidationError && err.message.includes('Unknown action'),
    );
  });

  await t.test('processStep validation: missing payload.racer throws ValidationError', () => {
    const engine = new DerbyEngine({ pickWinner: () => 3 });
    const metadata = engine.initiate({ params: { racers: 6 } });

    assert.throws(
      () => engine.processStep({
        metadata,
        action: 'bet',
        payload: {},
      }),
      (err) => err instanceof ValidationError && err.message.includes('payload.racer'),
    );
  });

  await t.test('processStep validation: null payload throws ValidationError', () => {
    const engine = new DerbyEngine({ pickWinner: () => 3 });
    const metadata = engine.initiate({ params: { racers: 6 } });

    assert.throws(
      () => engine.processStep({
        metadata,
        action: 'bet',
        payload: null,
      }),
      (err) => err instanceof ValidationError && err.message.includes('payload.racer'),
    );
  });

  await t.test('processStep validation: racer out of bounds (too high) throws ValidationError', () => {
    const engine = new DerbyEngine({ pickWinner: () => 3 });
    const metadata = engine.initiate({ params: { racers: 6 } });

    assert.throws(
      () => engine.processStep({
        metadata,
        action: 'bet',
        payload: { racer: 6 },
      }),
      (err) => err instanceof ValidationError && err.message.includes('integer in [0, 5]'),
    );
  });

  await t.test('processStep validation: racer negative throws ValidationError', () => {
    const engine = new DerbyEngine({ pickWinner: () => 3 });
    const metadata = engine.initiate({ params: { racers: 6 } });

    assert.throws(
      () => engine.processStep({
        metadata,
        action: 'bet',
        payload: { racer: -1 },
      }),
      (err) => err instanceof ValidationError && err.message.includes('integer in [0, 5]'),
    );
  });

  await t.test('processStep validation: racer not integer throws ValidationError', () => {
    const engine = new DerbyEngine({ pickWinner: () => 3 });
    const metadata = engine.initiate({ params: { racers: 6 } });

    assert.throws(
      () => engine.processStep({
        metadata,
        action: 'bet',
        payload: { racer: 2.5 },
      }),
      (err) => err instanceof ValidationError && err.message.includes('integer in [0, 5]'),
    );
  });

  await t.test('processStep validation: racer string throws ValidationError', () => {
    const engine = new DerbyEngine({ pickWinner: () => 3 });
    const metadata = engine.initiate({ params: { racers: 6 } });

    assert.throws(
      () => engine.processStep({
        metadata,
        action: 'bet',
        payload: { racer: 'x' },
      }),
      (err) => err instanceof ValidationError && err.message.includes('payload.racer'),
    );
  });

  await t.test('processStep conflict: null metadata throws ConflictError', () => {
    const engine = new DerbyEngine();

    assert.throws(
      () => engine.processStep({
        metadata: null,
        action: 'bet',
        payload: { racer: 0 },
      }),
      (err) => err instanceof ConflictError && err.message.includes('no game state'),
    );
  });

  await t.test('processStep conflict: game already over throws ConflictError', () => {
    const engine = new DerbyEngine({ pickWinner: () => 3 });
    const metadata = engine.initiate({ params: { racers: 6 } });
    const stepResult = engine.processStep({
      metadata,
      action: 'bet',
      payload: { racer: 3 },
    });

    assert.throws(
      () => engine.processStep({
        metadata: stepResult.metadata,
        action: 'bet',
        payload: { racer: 0 },
      }),
      (err) => err instanceof ConflictError && err.message.includes('already over'),
    );
  });

  await t.test('result object has exactly correct keys', () => {
    const engine = new DerbyEngine({ pickWinner: () => 3 });
    const metadata = engine.initiate({ params: { racers: 6 } });
    const stepResult = engine.processStep({
      metadata,
      action: 'bet',
      payload: { racer: 3 },
    });

    const resultKeys = Object.keys(stepResult.result).sort();
    const expectedKeys = ['multiplier', 'win', 'winner'].sort();

    assert.deepStrictEqual(resultKeys, expectedKeys);
  });

  await t.test('never mutates input metadata', () => {
    const engine = new DerbyEngine({ pickWinner: () => 3 });
    const originalMetadata = engine.initiate({ params: { racers: 6 } });
    const metadata = JSON.parse(JSON.stringify(originalMetadata));

    engine.processStep({
      metadata,
      action: 'bet',
      payload: { racer: 3 },
    });

    assert.deepStrictEqual(metadata, originalMetadata);
  });

  await t.test('different racer counts calculate correct multipliers', () => {
    const testCases = [
      { racers: 2, expectedMultiplier: 2 },
      { racers: 5, expectedMultiplier: 5 },
      { racers: 12, expectedMultiplier: 12 },
    ];

    for (const testCase of testCases) {
      const engine = new DerbyEngine({
        pickWinner: (racers) => 0,
      });
      const metadata = engine.initiate({ params: { racers: testCase.racers } });

      const result = engine.processStep({
        metadata,
        action: 'bet',
        payload: { racer: 0 },
      });

      assert.strictEqual(
        result.result.multiplier,
        testCase.expectedMultiplier,
        `Multiplier mismatch for ${testCase.racers} racers`,
      );
    }
  });

  await t.test('gameKey returns derby', () => {
    const engine = new DerbyEngine();
    assert.strictEqual(engine.gameKey, 'derby');
  });
});
