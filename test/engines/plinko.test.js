'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const PlinkoEngine = require('../../src/engines/plinko');
const { AppError, ValidationError, ConflictError } = require('../../src/errors');
const { rawPayout } = require('../../src/engines/payout');

/** Injects a fixed, ordered sequence of dropStep() results (0=left, 1=right). */
function makeSteps(sequence) {
  let i = 0;
  return {
    dropStep: () => {
      const value = sequence[i];
      i += 1;
      return value;
    },
  };
}

test('gameKey returns plinko', () => {
  const engine = new PlinkoEngine();
  assert.strictEqual(engine.gameKey, 'plinko');
});

test('initiate sets IN_PROGRESS outcome with no other state', () => {
  const engine = new PlinkoEngine();
  const metadata = engine.initiate();
  assert.deepStrictEqual(metadata, { outcome: 'IN_PROGRESS' });
});

test('all-left drop lands in slot 0 at 12.0x and pays via rawPayout', () => {
  const engine = new PlinkoEngine(makeSteps([0, 0, 0, 0, 0, 0, 0, 0]));
  const metadata = engine.initiate();

  const { metadata: next, status, result } = engine.processStep({ metadata, action: 'drop' });

  assert.strictEqual(status, 'WIN');
  assert.strictEqual(next.outcome, 'DROPPED');
  assert.strictEqual(next.slot, 0);
  assert.strictEqual(next.multiplierBps, 120000);

  assert.strictEqual(result.slot, 0);
  assert.deepStrictEqual(result.path, ['L', 'L', 'L', 'L', 'L', 'L', 'L', 'L']);
  assert.strictEqual(result.multiplier, 12.0);

  const payout = engine.settle({ session: { pointsBet: 10 }, metadata: next });
  assert.strictEqual(payout, rawPayout(10, 120000));
  assert.strictEqual(payout, 120); // floor(10 * 120000 / 10000) = 120
});

test('all-right drop lands in slot 8 at 12.0x', () => {
  const engine = new PlinkoEngine(makeSteps([1, 1, 1, 1, 1, 1, 1, 1]));
  const metadata = engine.initiate();

  const { metadata: next, status, result } = engine.processStep({ metadata, action: 'drop' });

  assert.strictEqual(status, 'WIN');
  assert.strictEqual(next.slot, 8);
  assert.strictEqual(next.multiplierBps, 120000);
  assert.strictEqual(result.slot, 8);
  assert.deepStrictEqual(result.path, ['R', 'R', 'R', 'R', 'R', 'R', 'R', 'R']);
  assert.strictEqual(result.multiplier, 12.0);
});

test('a middle slot (4 rights of 8) resolves to slot 4 at 0.25x — a partial return', () => {
  const engine = new PlinkoEngine(makeSteps([1, 0, 1, 0, 1, 0, 1, 0]));
  const metadata = engine.initiate();

  const { metadata: next, status, result } = engine.processStep({ metadata, action: 'drop' });

  assert.strictEqual(status, 'WIN');
  assert.strictEqual(next.slot, 4);
  assert.strictEqual(next.multiplierBps, 2500);
  assert.deepStrictEqual(result.path, ['R', 'L', 'R', 'L', 'R', 'L', 'R', 'L']);
  assert.strictEqual(result.multiplier, 0.25);

  const payout = engine.settle({ session: { pointsBet: 100 }, metadata: next });
  assert.strictEqual(payout, rawPayout(100, 2500));
  assert.strictEqual(payout, 25); // floor(100 * 2500 / 10000) = 25, a partial return of the bet
});

test('result has exactly the keys slot, path, multiplier; path length 8; slot equals count of R', () => {
  const engine = new PlinkoEngine(makeSteps([1, 1, 0, 1, 0, 0, 1, 0]));
  const metadata = engine.initiate();

  const { result } = engine.processStep({ metadata, action: 'drop' });

  assert.deepStrictEqual(Object.keys(result).sort(), ['multiplier', 'path', 'slot'].sort());
  assert.strictEqual(result.path.length, 8);
  const rightCount = result.path.filter((step) => step === 'R').length;
  assert.strictEqual(result.slot, rightCount);
});

test('unknown action throws ValidationError', () => {
  const engine = new PlinkoEngine(makeSteps([0, 0, 0, 0, 0, 0, 0, 0]));
  const metadata = engine.initiate();

  assert.throws(
    () => {
      engine.processStep({ metadata, action: 'peek' });
    },
    (err) => err instanceof ValidationError && err.code === 'VALIDATION_ERROR'
  );
});

test('a dropStep() returning something other than 0/1 throws an internal AppError, not a client ValidationError', () => {
  const engine = new PlinkoEngine(makeSteps([2]));
  const metadata = engine.initiate();

  assert.throws(
    () => {
      engine.processStep({ metadata, action: 'drop' });
    },
    (err) => err instanceof AppError && err.code === 'INTERNAL_ERROR' && err.status === 500
  );
});

test('null metadata throws ConflictError', () => {
  const engine = new PlinkoEngine(makeSteps([0, 0, 0, 0, 0, 0, 0, 0]));

  assert.throws(
    () => {
      engine.processStep({ metadata: null, action: 'drop' });
    },
    (err) => err instanceof ConflictError && err.code === 'CONFLICT'
  );
});

test('acting after a DROPPED terminal outcome throws ConflictError', () => {
  const engine = new PlinkoEngine(makeSteps([0, 0, 0, 0, 0, 0, 0, 0]));
  const metadata = engine.initiate();
  const { metadata: terminal } = engine.processStep({ metadata, action: 'drop' });
  assert.strictEqual(terminal.outcome, 'DROPPED');

  assert.throws(
    () => {
      engine.processStep({ metadata: terminal, action: 'drop' });
    },
    (err) => err instanceof ConflictError && err.code === 'CONFLICT'
  );
});

test('settle returns 0 when metadata outcome is not DROPPED', () => {
  const engine = new PlinkoEngine();
  const payout = engine.settle({ session: { pointsBet: 100 }, metadata: { outcome: 'IN_PROGRESS' } });
  assert.strictEqual(payout, 0);
});

test('settle returns 0 when metadata is missing (null)', () => {
  const engine = new PlinkoEngine();
  const payout = engine.settle({ session: { pointsBet: 100 }, metadata: null });
  assert.strictEqual(payout, 0);
});

test('SLOT_MULTIPLIERS_BPS has 9 entries and is symmetric', () => {
  const { SLOT_MULTIPLIERS_BPS } = require('../../src/engines/plinko');
  assert.strictEqual(SLOT_MULTIPLIERS_BPS.length, 9);
  for (let i = 0; i < SLOT_MULTIPLIERS_BPS.length; i += 1) {
    assert.strictEqual(
      SLOT_MULTIPLIERS_BPS[i],
      SLOT_MULTIPLIERS_BPS[SLOT_MULTIPLIERS_BPS.length - 1 - i],
      `slot ${i} must mirror slot ${SLOT_MULTIPLIERS_BPS.length - 1 - i}`
    );
  }
});
