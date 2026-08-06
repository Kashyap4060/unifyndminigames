'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const DiceTowerEngine = require('../../src/engines/diceTower');
const { ValidationError, ConflictError } = require('../../src/errors');

/**
 * Helper to create a deterministic roller. Returns successive values from
 * an array, cycling or repeating the last if exhausted.
 */
function makeRoller(values) {
  let index = 0;
  return () => {
    const value = values[index];
    if (index < values.length - 1) {
      index += 1;
    }
    return value;
  };
}

test('initiate returns IN_PROGRESS outcome', () => {
  const engine = new DiceTowerEngine();
  const metadata = engine.initiate();
  assert.strictEqual(metadata.outcome, 'IN_PROGRESS');
});

test('gameKey returns dice_tower', () => {
  const engine = new DiceTowerEngine();
  assert.strictEqual(engine.gameKey, 'dice_tower');
});

test('high prediction WIN with sum 10', () => {
  const engine = new DiceTowerEngine({ rollDie: makeRoller([4, 6]) });
  const metadata = engine.initiate();
  const { metadata: newMetadata, status, result } = engine.processStep({
    metadata,
    action: 'roll',
    payload: { prediction: 'high' },
  });

  assert.strictEqual(status, 'WIN');
  assert.strictEqual(newMetadata.outcome, 'WON');
  assert.deepStrictEqual(newMetadata.dice, [4, 6]);
  assert.strictEqual(newMetadata.sum, 10);
  assert.strictEqual(newMetadata.prediction, 'high');
  assert.strictEqual(newMetadata.multiplierBps, 24000);

  // Result shape: { dice, sum, win, multiplier }
  assert.deepStrictEqual(result.dice, [4, 6]);
  assert.strictEqual(result.sum, 10);
  assert.strictEqual(result.win, true);
  assert.strictEqual(result.multiplier, 2.4);
});

test('high prediction LOSE with sum 5', () => {
  const engine = new DiceTowerEngine({ rollDie: makeRoller([2, 3]) });
  const metadata = engine.initiate();
  const { metadata: newMetadata, status, result } = engine.processStep({
    metadata,
    action: 'roll',
    payload: { prediction: 'high' },
  });

  assert.strictEqual(status, 'LOSE');
  assert.strictEqual(newMetadata.outcome, 'LOST');
  assert.deepStrictEqual(newMetadata.dice, [2, 3]);
  assert.strictEqual(newMetadata.sum, 5);
  assert.strictEqual(newMetadata.prediction, 'high');
  assert.strictEqual(newMetadata.multiplierBps, 0);

  assert.deepStrictEqual(result.dice, [2, 3]);
  assert.strictEqual(result.sum, 5);
  assert.strictEqual(result.win, false);
  assert.strictEqual(result.multiplier, 0);
});

test('low prediction WIN with sum 4', () => {
  const engine = new DiceTowerEngine({ rollDie: makeRoller([1, 3]) });
  const metadata = engine.initiate();
  const { metadata: newMetadata, status, result } = engine.processStep({
    metadata,
    action: 'roll',
    payload: { prediction: 'low' },
  });

  assert.strictEqual(status, 'WIN');
  assert.strictEqual(newMetadata.outcome, 'WON');
  assert.deepStrictEqual(newMetadata.dice, [1, 3]);
  assert.strictEqual(newMetadata.sum, 4);
  assert.strictEqual(newMetadata.prediction, 'low');
  assert.strictEqual(newMetadata.multiplierBps, 24000);

  assert.deepStrictEqual(result.dice, [1, 3]);
  assert.strictEqual(result.sum, 4);
  assert.strictEqual(result.win, true);
  assert.strictEqual(result.multiplier, 2.4);
});

test('seven prediction WIN with sum 7', () => {
  const engine = new DiceTowerEngine({ rollDie: makeRoller([3, 4]) });
  const metadata = engine.initiate();
  const { metadata: newMetadata, status, result } = engine.processStep({
    metadata,
    action: 'roll',
    payload: { prediction: 'seven' },
  });

  assert.strictEqual(status, 'WIN');
  assert.strictEqual(newMetadata.outcome, 'WON');
  assert.deepStrictEqual(newMetadata.dice, [3, 4]);
  assert.strictEqual(newMetadata.sum, 7);
  assert.strictEqual(newMetadata.prediction, 'seven');
  assert.strictEqual(newMetadata.multiplierBps, 60000);

  assert.deepStrictEqual(result.dice, [3, 4]);
  assert.strictEqual(result.sum, 7);
  assert.strictEqual(result.win, true);
  assert.strictEqual(result.multiplier, 6);
});

test('seven prediction LOSE with sum 8', () => {
  const engine = new DiceTowerEngine({ rollDie: makeRoller([4, 4]) });
  const metadata = engine.initiate();
  const { metadata: newMetadata, status, result } = engine.processStep({
    metadata,
    action: 'roll',
    payload: { prediction: 'seven' },
  });

  assert.strictEqual(status, 'LOSE');
  assert.strictEqual(newMetadata.outcome, 'LOST');
  assert.deepStrictEqual(newMetadata.dice, [4, 4]);
  assert.strictEqual(newMetadata.sum, 8);
  assert.strictEqual(newMetadata.prediction, 'seven');
  assert.strictEqual(newMetadata.multiplierBps, 0);

  assert.deepStrictEqual(result.dice, [4, 4]);
  assert.strictEqual(result.sum, 8);
  assert.strictEqual(result.win, false);
  assert.strictEqual(result.multiplier, 0);
});

test('invalid action throws ValidationError', () => {
  const engine = new DiceTowerEngine();
  const metadata = engine.initiate();

  assert.throws(
    () => {
      engine.processStep({
        metadata,
        action: 'invalid',
        payload: { prediction: 'high' },
      });
    },
    (err) => err instanceof ValidationError && err.code === 'VALIDATION_ERROR'
  );
});

test('invalid prediction throws ValidationError', () => {
  const engine = new DiceTowerEngine();
  const metadata = engine.initiate();

  assert.throws(
    () => {
      engine.processStep({
        metadata,
        action: 'roll',
        payload: { prediction: 'invalid' },
      });
    },
    (err) => err instanceof ValidationError && err.code === 'VALIDATION_ERROR'
  );
});

test('missing prediction throws ValidationError', () => {
  const engine = new DiceTowerEngine();
  const metadata = engine.initiate();

  assert.throws(
    () => {
      engine.processStep({
        metadata,
        action: 'roll',
        payload: {},
      });
    },
    (err) => err instanceof ValidationError && err.code === 'VALIDATION_ERROR'
  );
});

test('null metadata throws ConflictError', () => {
  const engine = new DiceTowerEngine();

  assert.throws(
    () => {
      engine.processStep({
        metadata: null,
        action: 'roll',
        payload: { prediction: 'high' },
      });
    },
    (err) => err instanceof ConflictError && err.code === 'CONFLICT'
  );
});

test('undefined payload throws ValidationError', () => {
  const engine = new DiceTowerEngine();
  const metadata = engine.initiate();

  assert.throws(
    () => {
      engine.processStep({
        metadata,
        action: 'roll',
        payload: undefined,
      });
    },
    (err) => err instanceof ValidationError && err.code === 'VALIDATION_ERROR'
  );
});

test('act after terminal outcome throws ConflictError', () => {
  const engine = new DiceTowerEngine();
  // Create a terminal metadata directly
  const terminalMetadata = {
    outcome: 'WON',
    dice: [3, 4],
    sum: 7,
    prediction: 'seven',
    multiplierBps: 60000,
  };

  // Try to act again on the already-finished game
  assert.throws(
    () => {
      engine.processStep({
        metadata: terminalMetadata,
        action: 'roll',
        payload: { prediction: 'high' },
      });
    },
    (err) => err instanceof ConflictError && err.code === 'CONFLICT'
  );
});

test('settle returns 0 for loss', () => {
  const engine = new DiceTowerEngine({ rollDie: makeRoller([2, 3]) });
  const metadata = engine.initiate();
  const { metadata: newMetadata } = engine.processStep({
    metadata,
    action: 'roll',
    payload: { prediction: 'high' },
  });

  const payout = engine.settle({
    session: { pointsBet: 100 },
    metadata: newMetadata,
  });

  assert.strictEqual(payout, 0);
});

test('settle returns correct payout for high win', () => {
  const engine = new DiceTowerEngine({ rollDie: makeRoller([4, 6]) });
  const metadata = engine.initiate();
  const { metadata: newMetadata } = engine.processStep({
    metadata,
    action: 'roll',
    payload: { prediction: 'high' },
  });

  // High win: 2.4x multiplier with 3% house edge
  // payout = floor(100 * 24000 * 9700 / (10000 * 10000))
  // = floor(100 * 24000 * 9700 / 100000000)
  // = floor(2328000000 / 100000000)
  // = floor(232.8) = 232
  const payout = engine.settle({
    session: { pointsBet: 100 },
    metadata: newMetadata,
  });

  assert.strictEqual(payout, 232);
});

test('settle returns correct payout for seven win', () => {
  const engine = new DiceTowerEngine({ rollDie: makeRoller([3, 4]) });
  const metadata = engine.initiate();
  const { metadata: newMetadata } = engine.processStep({
    metadata,
    action: 'roll',
    payload: { prediction: 'seven' },
  });

  // Seven win: 6.0x multiplier with 3% house edge
  // payout = floor(100 * 60000 * 9700 / (10000 * 10000))
  // = floor(100 * 60000 * 9700 / 100000000)
  // = floor(58200000 / 100000000)
  // = floor(582) = 582
  const payout = engine.settle({
    session: { pointsBet: 100 },
    metadata: newMetadata,
  });

  assert.strictEqual(payout, 582);
});

test('settle returns 0 when metadata is null', () => {
  const engine = new DiceTowerEngine();
  const payout = engine.settle({
    session: { pointsBet: 100 },
    metadata: null,
  });

  assert.strictEqual(payout, 0);
});

test('high boundary: sum 8 wins (low boundary for high)', () => {
  const engine = new DiceTowerEngine({ rollDie: makeRoller([2, 6]) });
  const metadata = engine.initiate();
  const { status, result } = engine.processStep({
    metadata,
    action: 'roll',
    payload: { prediction: 'high' },
  });

  assert.strictEqual(status, 'WIN');
  assert.strictEqual(result.sum, 8);
  assert.strictEqual(result.win, true);
});

test('low boundary: sum 7 loses (above max for low)', () => {
  const engine = new DiceTowerEngine({ rollDie: makeRoller([3, 4]) });
  const metadata = engine.initiate();
  const { status, result } = engine.processStep({
    metadata,
    action: 'roll',
    payload: { prediction: 'low' },
  });

  assert.strictEqual(status, 'LOSE');
  assert.strictEqual(result.sum, 7);
  assert.strictEqual(result.win, false);
});

test('low boundary: sum 6 wins (high boundary for low)', () => {
  const engine = new DiceTowerEngine({ rollDie: makeRoller([3, 3]) });
  const metadata = engine.initiate();
  const { status, result } = engine.processStep({
    metadata,
    action: 'roll',
    payload: { prediction: 'low' },
  });

  assert.strictEqual(status, 'WIN');
  assert.strictEqual(result.sum, 6);
  assert.strictEqual(result.win, true);
});
