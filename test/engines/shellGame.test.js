'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ShellGameEngine = require('../../src/engines/shellGame');
const { BPS_SCALE, payoutWithEdge } = require('../../src/engines/payout');
const { ValidationError, ConflictError } = require('../../src/errors');

// Win multiplier constant (must match the engine)
const WIN_MULTIPLIER_BPS = 3 * BPS_SCALE;

test('Shell Game Engine', async (t) => {
  await t.test('initiate: returns metadata with winningCup (0..2) and outcome IN_PROGRESS', () => {
    const engine = new ShellGameEngine({ pickWinner: () => 1 });
    const metadata = engine.initiate();

    assert.equal(metadata.outcome, 'IN_PROGRESS');
    assert.equal(typeof metadata.winningCup, 'number');
    assert.equal(metadata.winningCup, 1);
    assert(metadata.winningCup >= 0 && metadata.winningCup <= 2);
  });

  await t.test('initiate: winning cup is picked via injected pickWinner', () => {
    const engine0 = new ShellGameEngine({ pickWinner: () => 0 });
    assert.equal(engine0.initiate().winningCup, 0);

    const engine2 = new ShellGameEngine({ pickWinner: () => 2 });
    assert.equal(engine2.initiate().winningCup, 2);
  });

  await t.test('initiate: returns object with only winningCup and outcome keys', () => {
    const engine = new ShellGameEngine({ pickWinner: () => 1 });
    const metadata = engine.initiate();
    const keys = Object.keys(metadata).sort();

    assert.deepEqual(keys, ['outcome', 'winningCup']);
  });

  await t.test('WIN: pick matches winning cup → status WIN, result.win true, correct multiplier', () => {
    const engine = new ShellGameEngine({ pickWinner: () => 1 });
    const metadata = engine.initiate();

    const { metadata: nextMeta, status, result } = engine.processStep({
      metadata,
      action: 'pick',
      payload: { cup: 1 },
    });

    assert.equal(status, 'WIN');
    assert.equal(result.win, true);
    assert.equal(result.revealedCup, 1);
    assert.equal(result.multiplier, 3);
    assert.equal(nextMeta.outcome, 'WON');
    assert.equal(nextMeta.multiplierBps, WIN_MULTIPLIER_BPS);
    assert.equal(nextMeta.pick, 1);
  });

  await t.test('WIN: settle returns correct payout with house edge', () => {
    const engine = new ShellGameEngine({ pickWinner: () => 1 });
    const metadata = engine.initiate();

    const { metadata: nextMeta } = engine.processStep({
      metadata,
      action: 'pick',
      payload: { cup: 1 },
    });

    const session = { pointsBet: 10 };
    const payout = engine.settle({ session, metadata: nextMeta });
    const expected = payoutWithEdge(10, WIN_MULTIPLIER_BPS);

    assert.equal(payout, expected);
    assert.equal(payout, 29); // floor(10 * 3 * 0.97) = 29
  });

  await t.test('LOSE: pick does not match winning cup → status LOSE, result.win false', () => {
    const engine = new ShellGameEngine({ pickWinner: () => 1 });
    const metadata = engine.initiate();

    const { metadata: nextMeta, status, result } = engine.processStep({
      metadata,
      action: 'pick',
      payload: { cup: 0 },
    });

    assert.equal(status, 'LOSE');
    assert.equal(result.win, false);
    assert.equal(result.revealedCup, 1);
    assert.equal(result.multiplier, 0);
    assert.equal(nextMeta.outcome, 'LOST');
    assert.equal(nextMeta.multiplierBps, 0);
  });

  await t.test('LOSE: settle returns 0', () => {
    const engine = new ShellGameEngine({ pickWinner: () => 1 });
    const metadata = engine.initiate();

    const { metadata: nextMeta } = engine.processStep({
      metadata,
      action: 'pick',
      payload: { cup: 0 },
    });

    const session = { pointsBet: 100 };
    const payout = engine.settle({ session, metadata: nextMeta });

    assert.equal(payout, 0);
  });

  await t.test('result has exactly { win, revealedCup, multiplier } keys', () => {
    const engine = new ShellGameEngine({ pickWinner: () => 1 });
    const metadata = engine.initiate();

    const { result } = engine.processStep({
      metadata,
      action: 'pick',
      payload: { cup: 1 },
    });

    const resultKeys = Object.keys(result).sort();
    assert.deepEqual(resultKeys, ['multiplier', 'revealedCup', 'win']);
  });

  await t.test('ValidationError: invalid action', () => {
    const engine = new ShellGameEngine({ pickWinner: () => 1 });
    const metadata = engine.initiate();

    assert.throws(
      () =>
        engine.processStep({
          metadata,
          action: 'flip',
          payload: { cup: 1 },
        }),
      (err) => {
        assert.equal(err.code, 'VALIDATION_ERROR');
        assert(err.message.includes('Unknown action'));
        return true;
      },
    );
  });

  await t.test('ValidationError: missing payload.cup', () => {
    const engine = new ShellGameEngine({ pickWinner: () => 1 });
    const metadata = engine.initiate();

    assert.throws(
      () =>
        engine.processStep({
          metadata,
          action: 'pick',
          payload: {},
        }),
      (err) => {
        assert.equal(err.code, 'VALIDATION_ERROR');
        assert(err.message.includes('cup'));
        return true;
      },
    );
  });

  await t.test('ValidationError: payload.cup not a number', () => {
    const engine = new ShellGameEngine({ pickWinner: () => 1 });
    const metadata = engine.initiate();

    assert.throws(
      () =>
        engine.processStep({
          metadata,
          action: 'pick',
          payload: { cup: 'zero' },
        }),
      (err) => {
        assert.equal(err.code, 'VALIDATION_ERROR');
        return true;
      },
    );
  });

  await t.test('ValidationError: cup out of range (3)', () => {
    const engine = new ShellGameEngine({ pickWinner: () => 1 });
    const metadata = engine.initiate();

    assert.throws(
      () =>
        engine.processStep({
          metadata,
          action: 'pick',
          payload: { cup: 3 },
        }),
      (err) => {
        assert.equal(err.code, 'VALIDATION_ERROR');
        assert(err.message.includes('{0, 1, 2}'));
        return true;
      },
    );
  });

  await t.test('ValidationError: cup out of range (-1)', () => {
    const engine = new ShellGameEngine({ pickWinner: () => 1 });
    const metadata = engine.initiate();

    assert.throws(
      () =>
        engine.processStep({
          metadata,
          action: 'pick',
          payload: { cup: -1 },
        }),
      (err) => {
        assert.equal(err.code, 'VALIDATION_ERROR');
        return true;
      },
    );
  });

  await t.test('ValidationError: cup is float (1.5)', () => {
    const engine = new ShellGameEngine({ pickWinner: () => 1 });
    const metadata = engine.initiate();

    assert.throws(
      () =>
        engine.processStep({
          metadata,
          action: 'pick',
          payload: { cup: 1.5 },
        }),
      (err) => {
        assert.equal(err.code, 'VALIDATION_ERROR');
        return true;
      },
    );
  });

  await t.test('ConflictError: null metadata', () => {
    const engine = new ShellGameEngine({ pickWinner: () => 1 });

    assert.throws(
      () =>
        engine.processStep({
          metadata: null,
          action: 'pick',
          payload: { cup: 1 },
        }),
      (err) => {
        assert.equal(err.code, 'CONFLICT');
        assert(err.message.includes('game state'));
        return true;
      },
    );
  });

  await t.test('ConflictError: game already over (act after terminal outcome)', () => {
    const engine = new ShellGameEngine({ pickWinner: () => 1 });
    const metadata = engine.initiate();

    // First pick
    const { metadata: nextMeta } = engine.processStep({
      metadata,
      action: 'pick',
      payload: { cup: 1 },
    });

    // Try to pick again
    assert.throws(
      () =>
        engine.processStep({
          metadata: nextMeta,
          action: 'pick',
          payload: { cup: 0 },
        }),
      (err) => {
        assert.equal(err.code, 'CONFLICT');
        assert(err.message.includes('already over'));
        return true;
      },
    );
  });

  await t.test('settle: loss or no metadata returns 0', () => {
    const engine = new ShellGameEngine({ pickWinner: () => 1 });

    assert.equal(engine.settle({ session: { pointsBet: 100 }, metadata: null }), 0);

    const metadata = { outcome: 'LOST', multiplierBps: 0 };
    assert.equal(engine.settle({ session: { pointsBet: 100 }, metadata }), 0);
  });

  await t.test('gameKey returns shell_game', () => {
    const engine = new ShellGameEngine();
    assert.equal(engine.gameKey, 'shell_game');
  });

  await t.test('multiple games can have different winners via pickWinner injection', () => {
    const engine0 = new ShellGameEngine({ pickWinner: () => 0 });
    const engine1 = new ShellGameEngine({ pickWinner: () => 1 });
    const engine2 = new ShellGameEngine({ pickWinner: () => 2 });

    assert.equal(engine0.initiate().winningCup, 0);
    assert.equal(engine1.initiate().winningCup, 1);
    assert.equal(engine2.initiate().winningCup, 2);
  });
});
