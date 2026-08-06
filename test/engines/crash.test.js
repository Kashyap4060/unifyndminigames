'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const CrashEngine = require('../../src/engines/crash');
const { ValidationError, ConflictError } = require('../../src/errors');
const { BPS_SCALE, rawPayout } = require('../../src/engines/payout');

/** Injects a fixed hidden crash point (in bps) regardless of RNG. */
function fixedCrash(crashBps) {
  return { crashPoint: () => crashBps };
}

test('gameKey returns crash', () => {
  const engine = new CrashEngine();
  assert.strictEqual(engine.gameKey, 'crash');
});

test('initiate sets expected metadata shape with the hidden crash point', () => {
  const engine = new CrashEngine(fixedCrash(11000));
  const metadata = engine.initiate();

  assert.deepStrictEqual(metadata, {
    crashBps: 11000,
    currentBps: BPS_SCALE,
    outcome: 'IN_PROGRESS',
  });
});

test('a tick below the crash point continues and grows currentBps by 5%', () => {
  const engine = new CrashEngine(fixedCrash(11000));
  const metadata = engine.initiate();

  const { metadata: next, status, result } = engine.processStep({ metadata, action: 'tick' });

  // floor(10000 * 105 / 100) = 10500, which is < 11000 -> continue.
  assert.strictEqual(status, 'CONTINUE');
  assert.strictEqual(next.currentBps, 10500);
  assert.strictEqual(next.outcome, 'IN_PROGRESS');
  assert.strictEqual(next.crashBps, 11000);

  assert.strictEqual(result.action, 'tick');
  assert.strictEqual(result.crashed, false);
  assert.strictEqual(result.multiplier, 1.05);
  assert.ok(!Object.prototype.hasOwnProperty.call(result, 'crashBps'));
});

test('multiple ticks then a tick that reaches/exceeds the crash point busts', () => {
  const engine = new CrashEngine(fixedCrash(11000));
  const metadata = engine.initiate();

  // Tick 1: 10000 -> 10500 (continue).
  const step1 = engine.processStep({ metadata, action: 'tick' });
  assert.strictEqual(step1.status, 'CONTINUE');
  assert.strictEqual(step1.metadata.currentBps, 10500);

  // Tick 2: floor(10500 * 105 / 100) = 11025 >= 11000 -> bust.
  const step2 = engine.processStep({ metadata: step1.metadata, action: 'tick' });
  assert.strictEqual(step2.status, 'LOSE');
  assert.strictEqual(step2.metadata.outcome, 'CRASHED');
  // currentBps stays at its pre-bust value (10500), not the computed 11025.
  assert.strictEqual(step2.metadata.currentBps, 10500);
  assert.strictEqual(step2.metadata.crashBps, 11000);

  assert.strictEqual(step2.result.action, 'tick');
  assert.strictEqual(step2.result.crashed, true);
  assert.strictEqual(step2.result.multiplier, 1.05);
  assert.ok(!Object.prototype.hasOwnProperty.call(step2.result, 'crashBps'));

  const payout = engine.settle({ session: { pointsBet: 100 }, metadata: step2.metadata });
  assert.strictEqual(payout, 0);
});

test('cashout after one tick wins and settles at the current multiplier', () => {
  const engine = new CrashEngine(fixedCrash(11000));
  const metadata = engine.initiate();

  const step1 = engine.processStep({ metadata, action: 'tick' });
  assert.strictEqual(step1.metadata.currentBps, 10500);

  const { metadata: next, status, result } = engine.processStep({
    metadata: step1.metadata,
    action: 'cashout',
  });

  assert.strictEqual(status, 'WIN');
  assert.strictEqual(next.outcome, 'CASHED_OUT');
  assert.strictEqual(next.currentBps, 10500);
  assert.strictEqual(result.action, 'cashout');
  assert.strictEqual(result.multiplier, 1.05);
  assert.ok(!Object.prototype.hasOwnProperty.call(result, 'crashBps'));

  const payout = engine.settle({ session: { pointsBet: 100 }, metadata: next });
  // floor(100 * 10500 / 10000) = 105
  assert.strictEqual(payout, rawPayout(100, 10500));
  assert.strictEqual(payout, 105);
});

test('instant-bust crash point (crashBps 10000) busts on the very first tick', () => {
  const engine = new CrashEngine(fixedCrash(10000));
  const metadata = engine.initiate();
  assert.strictEqual(metadata.currentBps, BPS_SCALE);

  const { metadata: next, status, result } = engine.processStep({ metadata, action: 'tick' });

  // floor(10000 * 105 / 100) = 10500 >= 10000 -> immediate bust.
  assert.strictEqual(status, 'LOSE');
  assert.strictEqual(next.outcome, 'CRASHED');
  assert.strictEqual(next.currentBps, BPS_SCALE);
  assert.strictEqual(result.crashed, true);

  const payout = engine.settle({ session: { pointsBet: 100 }, metadata: next });
  assert.strictEqual(payout, 0);
});

test('settle returns 0 when metadata is missing (null)', () => {
  const engine = new CrashEngine(fixedCrash(11000));

  const payout = engine.settle({ session: { pointsBet: 100 }, metadata: null });
  assert.strictEqual(payout, 0);
});

test('unknown action throws ValidationError', () => {
  const engine = new CrashEngine(fixedCrash(11000));
  const metadata = engine.initiate();

  assert.throws(
    () => {
      engine.processStep({ metadata, action: 'peek' });
    },
    (err) => err instanceof ValidationError && err.code === 'VALIDATION_ERROR'
  );
});

test('acting after a CRASHED terminal outcome throws ConflictError', () => {
  const engine = new CrashEngine(fixedCrash(10000));
  const metadata = engine.initiate();
  const { metadata: terminal } = engine.processStep({ metadata, action: 'tick' });
  assert.strictEqual(terminal.outcome, 'CRASHED');

  assert.throws(
    () => {
      engine.processStep({ metadata: terminal, action: 'tick' });
    },
    (err) => err instanceof ConflictError && err.code === 'CONFLICT'
  );
  assert.throws(
    () => {
      engine.processStep({ metadata: terminal, action: 'cashout' });
    },
    (err) => err instanceof ConflictError && err.code === 'CONFLICT'
  );
});

test('acting after a CASHED_OUT terminal outcome throws ConflictError', () => {
  const engine = new CrashEngine(fixedCrash(11000));
  const metadata = engine.initiate();
  const { metadata: terminal } = engine.processStep({ metadata, action: 'cashout' });
  assert.strictEqual(terminal.outcome, 'CASHED_OUT');

  assert.throws(
    () => {
      engine.processStep({ metadata: terminal, action: 'tick' });
    },
    (err) => err instanceof ConflictError && err.code === 'CONFLICT'
  );
  assert.throws(
    () => {
      engine.processStep({ metadata: terminal, action: 'cashout' });
    },
    (err) => err instanceof ConflictError && err.code === 'CONFLICT'
  );
});

test('null metadata throws ConflictError', () => {
  const engine = new CrashEngine(fixedCrash(11000));

  assert.throws(
    () => {
      engine.processStep({ metadata: null, action: 'tick' });
    },
    (err) => err instanceof ConflictError && err.code === 'CONFLICT'
  );
});

test('result never contains crashBps across tick, cashout, and crash outcomes', () => {
  const continueEngine = new CrashEngine(fixedCrash(11000));
  const metadata = continueEngine.initiate();

  const tickStep = continueEngine.processStep({ metadata, action: 'tick' });
  assert.ok(!('crashBps' in tickStep.result));

  const cashoutStep = continueEngine.processStep({ metadata: tickStep.metadata, action: 'cashout' });
  assert.ok(!('crashBps' in cashoutStep.result));

  const bustEngine = new CrashEngine(fixedCrash(10000));
  const bustMetadata = bustEngine.initiate();
  const bustStep = bustEngine.processStep({ metadata: bustMetadata, action: 'tick' });
  assert.ok(!('crashBps' in bustStep.result));
});

test('defaultCrashPoint (real crypto RNG) always returns an integer in [10000, 100000]', () => {
  const ITERATIONS = 500;
  for (let i = 0; i < ITERATIONS; i += 1) {
    const engine = new CrashEngine();
    const metadata = engine.initiate();
    assert.ok(Number.isInteger(metadata.crashBps), `crashBps ${metadata.crashBps} must be an integer`);
    assert.ok(metadata.crashBps >= BPS_SCALE, `crashBps ${metadata.crashBps} must be >= ${BPS_SCALE}`);
    assert.ok(metadata.crashBps <= 100000, `crashBps ${metadata.crashBps} must be <= 100000`);
  }
});
