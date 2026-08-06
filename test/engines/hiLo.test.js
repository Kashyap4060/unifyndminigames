'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const HiLoEngine = require('../../src/engines/hiLo');
const { ValidationError, ConflictError } = require('../../src/errors');
const { BPS_SCALE, payoutWithEdge } = require('../../src/engines/payout');

/** Injects a fixed deck regardless of the shuffle input. */
function fixedDeck(values) {
  return { shuffle: () => [...values] };
}

test('gameKey returns hi_lo', () => {
  const engine = new HiLoEngine();
  assert.strictEqual(engine.gameKey, 'hi_lo');
});

test('initiate with default secureShuffle produces a full 52-card deck', () => {
  const engine = new HiLoEngine();
  const metadata = engine.initiate();

  assert.strictEqual(metadata.deck.length, 52);
  const counts = {};
  for (const value of metadata.deck) {
    assert.ok(value >= 2 && value <= 14, `value ${value} out of range`);
    counts[value] = (counts[value] || 0) + 1;
  }
  assert.strictEqual(Object.keys(counts).length, 13);
  for (let rank = 2; rank <= 14; rank += 1) {
    assert.strictEqual(counts[rank], 4);
  }
});

test('initiate with injected deck sets expected metadata shape', () => {
  const engine = new HiLoEngine(fixedDeck([5, 8, 9, 10]));
  const metadata = engine.initiate();

  assert.deepStrictEqual(metadata.deck, [5, 8, 9, 10]);
  assert.strictEqual(metadata.position, 1);
  assert.strictEqual(metadata.currentValue, 5);
  assert.strictEqual(metadata.multiplierBps, BPS_SCALE);
  assert.strictEqual(metadata.outcome, 'IN_PROGRESS');
});

test('correct "higher" guess continues and grows multiplier at fair odds', () => {
  const engine = new HiLoEngine(fixedDeck([5, 8, 9, 10]));
  const metadata = engine.initiate();

  const { metadata: next, status, result } = engine.processStep({
    metadata,
    action: 'guess',
    payload: { direction: 'higher' },
  });

  // favorable = 14 - 5 = 9; newMultiplierBps = floor(10000 * 13 / 9) = 14444
  assert.strictEqual(status, 'CONTINUE');
  assert.strictEqual(next.outcome, 'IN_PROGRESS');
  assert.strictEqual(next.position, 2);
  assert.strictEqual(next.currentValue, 8);
  assert.strictEqual(next.multiplierBps, 14444);

  assert.strictEqual(result.correct, true);
  assert.strictEqual(result.nextCard, 8);
  assert.strictEqual(result.multiplier, 1.4444);
  assert.strictEqual(result.cardsLeft, 2);
  assert.ok(!Object.prototype.hasOwnProperty.call(result, 'deck'));
});

test('correct "lower" guess continues and grows multiplier at fair odds', () => {
  const engine = new HiLoEngine(fixedDeck([10, 3, 9, 1]));
  const metadata = engine.initiate();

  const { metadata: next, status, result } = engine.processStep({
    metadata,
    action: 'guess',
    payload: { direction: 'lower' },
  });

  // favorable = 10 - 2 = 8; newMultiplierBps = floor(10000 * 13 / 8) = 16250
  assert.strictEqual(status, 'CONTINUE');
  assert.strictEqual(next.outcome, 'IN_PROGRESS');
  assert.strictEqual(next.position, 2);
  assert.strictEqual(next.currentValue, 3);
  assert.strictEqual(next.multiplierBps, 16250);

  assert.strictEqual(result.correct, true);
  assert.strictEqual(result.nextCard, 3);
  assert.strictEqual(result.multiplier, 1.625);
  assert.ok(!Object.prototype.hasOwnProperty.call(result, 'deck'));
});

test('wrong guess loses and settle pays 0', () => {
  const engine = new HiLoEngine(fixedDeck([5, 3, 9, 1]));
  const metadata = engine.initiate();

  const { metadata: next, status, result } = engine.processStep({
    metadata,
    action: 'guess',
    payload: { direction: 'higher' },
  });

  assert.strictEqual(status, 'LOSE');
  assert.strictEqual(next.outcome, 'LOST');
  assert.strictEqual(result.correct, false);
  assert.strictEqual(result.nextCard, 3);

  const payout = engine.settle({ session: { pointsBet: 100 }, metadata: next });
  assert.strictEqual(payout, 0);
});

test('a tie (next === current) is a loss, not a win', () => {
  const engine = new HiLoEngine(fixedDeck([7, 7, 9, 1]));
  const metadata = engine.initiate();

  const { metadata: next, status, result } = engine.processStep({
    metadata,
    action: 'guess',
    payload: { direction: 'higher' },
  });

  assert.strictEqual(status, 'LOSE');
  assert.strictEqual(next.outcome, 'LOST');
  assert.strictEqual(result.correct, false);

  const payout = engine.settle({ session: { pointsBet: 100 }, metadata: next });
  assert.strictEqual(payout, 0);
});

test('favorable === 0 (currentValue 14, higher) is a forced loss even if next is rigged', () => {
  const engine = new HiLoEngine(fixedDeck([14, 5, 9, 1]));
  const metadata = engine.initiate();

  const { metadata: next, status, result } = engine.processStep({
    metadata,
    action: 'guess',
    payload: { direction: 'higher' },
  });

  assert.strictEqual(status, 'LOSE');
  assert.strictEqual(next.outcome, 'LOST');
  assert.strictEqual(result.correct, false);
});

test('favorable === 0 (currentValue 2, lower) is a forced loss even if next is rigged', () => {
  const engine = new HiLoEngine(fixedDeck([2, 8, 9, 1]));
  const metadata = engine.initiate();

  const { metadata: next, status, result } = engine.processStep({
    metadata,
    action: 'guess',
    payload: { direction: 'lower' },
  });

  assert.strictEqual(status, 'LOSE');
  assert.strictEqual(next.outcome, 'LOST');
  assert.strictEqual(result.correct, false);
});

test('cashout while in progress wins and settles at the current multiplier', () => {
  const engine = new HiLoEngine(fixedDeck([5, 8, 9, 10]));
  const metadata = engine.initiate();

  const { metadata: next, status, result } = engine.processStep({
    metadata,
    action: 'cashout',
  });

  assert.strictEqual(status, 'WIN');
  assert.strictEqual(next.outcome, 'CASHED_OUT');
  assert.strictEqual(result.action, 'cashout');
  assert.strictEqual(result.multiplier, 1);
  assert.ok(!Object.prototype.hasOwnProperty.call(result, 'deck'));

  const payout = engine.settle({ session: { pointsBet: 100 }, metadata: next });
  assert.strictEqual(payout, payoutWithEdge(100, BPS_SCALE));
  assert.strictEqual(payout, 97);
});

test('deck exhausted after a correct guess forces a WIN (cashed out)', () => {
  const engine = new HiLoEngine(fixedDeck([5, 8]));
  const metadata = engine.initiate();

  const { metadata: next, status, result } = engine.processStep({
    metadata,
    action: 'guess',
    payload: { direction: 'higher' },
  });

  assert.strictEqual(status, 'WIN');
  assert.strictEqual(next.outcome, 'CASHED_OUT');
  assert.strictEqual(result.correct, true);
  assert.strictEqual(result.cardsLeft, 0);
  assert.ok(!Object.prototype.hasOwnProperty.call(result, 'deck'));
});

test('two correct guesses in a row compound the multiplier (not reset per step)', () => {
  const engine = new HiLoEngine(fixedDeck([5, 8, 10, 2]));
  const metadata = engine.initiate();

  // Step 1: current 5, guess higher, next 8 -> correct.
  // favorable1 = 14 - 5 = 9; multiplierBps1 = floor(10000 * 13 / 9) = 14444.
  const step1 = engine.processStep({
    metadata,
    action: 'guess',
    payload: { direction: 'higher' },
  });
  const favorable1 = 14 - 5;
  const multiplierBps1 = Math.floor((BPS_SCALE * 13) / favorable1);

  assert.strictEqual(step1.status, 'CONTINUE');
  assert.strictEqual(step1.metadata.position, 2);
  assert.strictEqual(step1.metadata.currentValue, 8);
  assert.strictEqual(step1.metadata.multiplierBps, multiplierBps1);
  assert.strictEqual(multiplierBps1, 14444);

  // Step 2: thread step1's metadata in. current 8, guess higher, next 10 -> correct.
  // favorable2 = 14 - 8 = 6; multiplierBps2 = floor(multiplierBps1 * 13 / 6),
  // i.e. it MUST compound on top of multiplierBps1, not reset to BPS_SCALE.
  const step2 = engine.processStep({
    metadata: step1.metadata,
    action: 'guess',
    payload: { direction: 'higher' },
  });
  const favorable2 = 14 - 8;
  const multiplierBps2 = Math.floor((multiplierBps1 * 13) / favorable2);

  assert.strictEqual(step2.status, 'CONTINUE');
  assert.strictEqual(step2.metadata.position, 3);
  assert.strictEqual(step2.metadata.currentValue, 10);
  assert.strictEqual(step2.metadata.multiplierBps, multiplierBps2);
  assert.strictEqual(multiplierBps2, 31295);
  assert.notStrictEqual(step2.metadata.multiplierBps, Math.floor((BPS_SCALE * 13) / favorable2));
});

test('invalid direction throws ValidationError', () => {
  const engine = new HiLoEngine(fixedDeck([5, 8, 9, 10]));
  const metadata = engine.initiate();

  assert.throws(
    () => {
      engine.processStep({
        metadata,
        action: 'guess',
        payload: { direction: 'sideways' },
      });
    },
    (err) => err instanceof ValidationError && err.code === 'VALIDATION_ERROR'
  );
});

test('invalid action throws ValidationError', () => {
  const engine = new HiLoEngine(fixedDeck([5, 8, 9, 10]));
  const metadata = engine.initiate();

  assert.throws(
    () => {
      engine.processStep({
        metadata,
        action: 'peek',
        payload: { direction: 'higher' },
      });
    },
    (err) => err instanceof ValidationError && err.code === 'VALIDATION_ERROR'
  );
});

test('null metadata throws ConflictError', () => {
  const engine = new HiLoEngine();

  assert.throws(
    () => {
      engine.processStep({
        metadata: null,
        action: 'guess',
        payload: { direction: 'higher' },
      });
    },
    (err) => err instanceof ConflictError && err.code === 'CONFLICT'
  );
});

test('acting after a terminal outcome throws ConflictError', () => {
  const engine = new HiLoEngine(fixedDeck([5, 3, 9, 1]));
  const metadata = engine.initiate();
  const { metadata: terminal } = engine.processStep({
    metadata,
    action: 'guess',
    payload: { direction: 'higher' },
  });

  assert.strictEqual(terminal.outcome, 'LOST');
  assert.throws(
    () => {
      engine.processStep({
        metadata: terminal,
        action: 'guess',
        payload: { direction: 'higher' },
      });
    },
    (err) => err instanceof ConflictError && err.code === 'CONFLICT'
  );
});

test('result never contains the deck across all step types', () => {
  const engine = new HiLoEngine(fixedDeck([5, 8, 9, 10]));
  const metadata = engine.initiate();

  const guessStep = engine.processStep({
    metadata,
    action: 'guess',
    payload: { direction: 'higher' },
  });
  assert.ok(!('deck' in guessStep.result));

  const cashoutStep = engine.processStep({
    metadata: guessStep.metadata,
    action: 'cashout',
  });
  assert.ok(!('deck' in cashoutStep.result));

  const loseEngine = new HiLoEngine(fixedDeck([5, 3, 9, 1]));
  const loseMetadata = loseEngine.initiate();
  const loseStep = loseEngine.processStep({
    metadata: loseMetadata,
    action: 'guess',
    payload: { direction: 'higher' },
  });
  assert.ok(!('deck' in loseStep.result));
});
