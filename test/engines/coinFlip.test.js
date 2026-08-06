'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const CoinFlipEngine = require('../../src/engines/coinFlip');
const { ValidationError, ConflictError } = require('../../src/errors');
const { payoutWithEdge } = require('../../src/engines/payout');

describe('CoinFlipEngine', () => {
  describe('gameKey', () => {
    it('returns "coin_flip"', () => {
      const engine = new CoinFlipEngine();
      assert.strictEqual(engine.gameKey, 'coin_flip');
    });
  });

  describe('initiate()', () => {
    it('returns metadata with outcome IN_PROGRESS', () => {
      const engine = new CoinFlipEngine();
      const metadata = engine.initiate({});
      assert.deepStrictEqual(metadata, { outcome: 'IN_PROGRESS' });
    });

    it('ignores params (no params needed)', () => {
      const engine = new CoinFlipEngine();
      const metadata = engine.initiate({ params: { foo: 'bar' } });
      assert.deepStrictEqual(metadata, { outcome: 'IN_PROGRESS' });
    });
  });

  describe('processStep()', () => {
    describe('validation', () => {
      it('throws ConflictError if metadata is null', () => {
        const engine = new CoinFlipEngine();
        assert.throws(
          () => engine.processStep({ metadata: null, action: 'flip', payload: { side: 'heads' } }),
          (err) => err instanceof ConflictError && err.code === 'CONFLICT',
        );
      });

      it('throws ConflictError if metadata is undefined', () => {
        const engine = new CoinFlipEngine();
        assert.throws(
          () => engine.processStep({ metadata: undefined, action: 'flip', payload: { side: 'heads' } }),
          (err) => err instanceof ConflictError && err.code === 'CONFLICT',
        );
      });

      it('throws ConflictError if outcome is not IN_PROGRESS', () => {
        const engine = new CoinFlipEngine();
        const metadata = { outcome: 'WON', side: 'heads', flip: 'heads', multiplierBps: 20000 };
        assert.throws(
          () => engine.processStep({ metadata, action: 'flip', payload: { side: 'heads' } }),
          (err) => err instanceof ConflictError && err.code === 'CONFLICT' && err.message === 'Game is already over',
        );
      });

      it('throws ConflictError if outcome is LOST', () => {
        const engine = new CoinFlipEngine();
        const metadata = { outcome: 'LOST', side: 'heads', flip: 'tails', multiplierBps: 0 };
        assert.throws(
          () => engine.processStep({ metadata, action: 'flip', payload: { side: 'heads' } }),
          (err) => err instanceof ConflictError && err.code === 'CONFLICT',
        );
      });

      it('throws ValidationError if action is not "flip"', () => {
        const engine = new CoinFlipEngine();
        const metadata = { outcome: 'IN_PROGRESS' };
        assert.throws(
          () => engine.processStep({ metadata, action: 'spin', payload: { side: 'heads' } }),
          (err) => err instanceof ValidationError && err.code === 'VALIDATION_ERROR',
        );
      });

      it('throws ValidationError if payload is missing', () => {
        const engine = new CoinFlipEngine();
        const metadata = { outcome: 'IN_PROGRESS' };
        assert.throws(
          () => engine.processStep({ metadata, action: 'flip', payload: null }),
          (err) => err instanceof ValidationError && err.code === 'VALIDATION_ERROR',
        );
      });

      it('throws ValidationError if payload.side is not a string', () => {
        const engine = new CoinFlipEngine();
        const metadata = { outcome: 'IN_PROGRESS' };
        assert.throws(
          () => engine.processStep({ metadata, action: 'flip', payload: { side: 123 } }),
          (err) => err instanceof ValidationError && err.code === 'VALIDATION_ERROR',
        );
      });

      it('throws ValidationError if side is not "heads" or "tails"', () => {
        const engine = new CoinFlipEngine();
        const metadata = { outcome: 'IN_PROGRESS' };
        assert.throws(
          () => engine.processStep({ metadata, action: 'flip', payload: { side: 'edge' } }),
          (err) => err instanceof ValidationError && err.code === 'VALIDATION_ERROR',
        );
      });
    });

    describe('WIN path (heads)', () => {
      it('returns WIN status, correct metadata, and result when flip matches side (heads)', () => {
        // Force flip to return 0 (heads)
        const engine = new CoinFlipEngine({ flip: () => 0 });
        const metadata = { outcome: 'IN_PROGRESS' };

        const result = engine.processStep({
          metadata,
          action: 'flip',
          payload: { side: 'heads' },
        });

        assert.strictEqual(result.status, 'WIN');
        assert.deepStrictEqual(result.metadata, {
          outcome: 'WON',
          side: 'heads',
          flip: 'heads',
          multiplierBps: 20000,
        });
        assert.deepStrictEqual(result.result, {
          flip: 'heads',
          win: true,
          multiplier: 2,
        });
      });

      it('settles to correct payout on WIN', () => {
        const engine = new CoinFlipEngine({ flip: () => 0 });
        const metadata = { outcome: 'IN_PROGRESS' };

        const step = engine.processStep({
          metadata,
          action: 'flip',
          payload: { side: 'heads' },
        });

        const session = { pointsBet: 10 };
        const payout = engine.settle({ session, metadata: step.metadata });

        // Expected: floor(10 * 20000 * 9700 / 10000^2) = floor(10 * 2 * 0.97) = floor(19.4) = 19
        const expected = payoutWithEdge(10, 20000);
        assert.strictEqual(payout, expected);
        assert.strictEqual(payout, 19);
      });

      it('result does not leak hidden fields', () => {
        const engine = new CoinFlipEngine({ flip: () => 0 });
        const metadata = { outcome: 'IN_PROGRESS' };

        const step = engine.processStep({
          metadata,
          action: 'flip',
          payload: { side: 'heads' },
        });

        const resultKeys = Object.keys(step.result);
        assert.deepStrictEqual(resultKeys.sort(), ['flip', 'multiplier', 'win'].sort());
        assert.strictEqual(step.result.outcome, undefined);
        assert.strictEqual(step.result.side, undefined);
        assert.strictEqual(step.result.multiplierBps, undefined);
      });
    });

    describe('WIN path (tails)', () => {
      it('returns WIN status when flip matches side (tails)', () => {
        // Force flip to return 1 (tails)
        const engine = new CoinFlipEngine({ flip: () => 1 });
        const metadata = { outcome: 'IN_PROGRESS' };

        const result = engine.processStep({
          metadata,
          action: 'flip',
          payload: { side: 'tails' },
        });

        assert.strictEqual(result.status, 'WIN');
        assert.strictEqual(result.metadata.outcome, 'WON');
        assert.strictEqual(result.metadata.flip, 'tails');
        assert.strictEqual(result.result.win, true);
        assert.strictEqual(result.result.multiplier, 2);
      });

      it('settles to correct payout on WIN (tails)', () => {
        const engine = new CoinFlipEngine({ flip: () => 1 });
        const metadata = { outcome: 'IN_PROGRESS' };

        const step = engine.processStep({
          metadata,
          action: 'flip',
          payload: { side: 'tails' },
        });

        const session = { pointsBet: 100 };
        const payout = engine.settle({ session, metadata: step.metadata });

        const expected = payoutWithEdge(100, 20000);
        assert.strictEqual(payout, expected);
      });
    });

    describe('LOSE path (heads chosen, tails flipped)', () => {
      it('returns LOSE status when flip does not match side', () => {
        // Force flip to return 1 (tails)
        const engine = new CoinFlipEngine({ flip: () => 1 });
        const metadata = { outcome: 'IN_PROGRESS' };

        const result = engine.processStep({
          metadata,
          action: 'flip',
          payload: { side: 'heads' },
        });

        assert.strictEqual(result.status, 'LOSE');
        assert.deepStrictEqual(result.metadata, {
          outcome: 'LOST',
          side: 'heads',
          flip: 'tails',
          multiplierBps: 0,
        });
        assert.deepStrictEqual(result.result, {
          flip: 'tails',
          win: false,
          multiplier: 0,
        });
      });

      it('settles to 0 on LOSE', () => {
        const engine = new CoinFlipEngine({ flip: () => 1 });
        const metadata = { outcome: 'IN_PROGRESS' };

        const step = engine.processStep({
          metadata,
          action: 'flip',
          payload: { side: 'heads' },
        });

        const session = { pointsBet: 10 };
        const payout = engine.settle({ session, metadata: step.metadata });

        assert.strictEqual(payout, 0);
      });
    });

    describe('LOSE path (tails chosen, heads flipped)', () => {
      it('returns LOSE status when flip is opposite', () => {
        // Force flip to return 0 (heads)
        const engine = new CoinFlipEngine({ flip: () => 0 });
        const metadata = { outcome: 'IN_PROGRESS' };

        const result = engine.processStep({
          metadata,
          action: 'flip',
          payload: { side: 'tails' },
        });

        assert.strictEqual(result.status, 'LOSE');
        assert.strictEqual(result.metadata.outcome, 'LOST');
        assert.strictEqual(result.metadata.flip, 'heads');
        assert.strictEqual(result.result.win, false);
        assert.strictEqual(result.result.multiplier, 0);
      });

      it('settles to 0 on LOSE (tails chosen)', () => {
        const engine = new CoinFlipEngine({ flip: () => 0 });
        const metadata = { outcome: 'IN_PROGRESS' };

        const step = engine.processStep({
          metadata,
          action: 'flip',
          payload: { side: 'tails' },
        });

        const session = { pointsBet: 50 };
        const payout = engine.settle({ session, metadata: step.metadata });

        assert.strictEqual(payout, 0);
      });
    });

    describe('multiple flips (game terminal)', () => {
      it('allows only one flip per session (second flip on WON metadata throws)', () => {
        const engine = new CoinFlipEngine({ flip: () => 0 });
        const metadata = { outcome: 'WON', side: 'heads', flip: 'heads', multiplierBps: 20000 };

        assert.throws(
          () => engine.processStep({
            metadata,
            action: 'flip',
            payload: { side: 'tails' },
          }),
          (err) => err instanceof ConflictError && err.code === 'CONFLICT',
        );
      });

      it('allows only one flip per session (second flip on LOST metadata throws)', () => {
        const engine = new CoinFlipEngine({ flip: () => 0 });
        const metadata = { outcome: 'LOST', side: 'tails', flip: 'heads', multiplierBps: 0 };

        assert.throws(
          () => engine.processStep({
            metadata,
            action: 'flip',
            payload: { side: 'heads' },
          }),
          (err) => err instanceof ConflictError && err.code === 'CONFLICT',
        );
      });
    });
  });

  describe('settle()', () => {
    it('returns 0 if metadata is null', () => {
      const engine = new CoinFlipEngine();
      const session = { pointsBet: 100 };
      const payout = engine.settle({ session, metadata: null });
      assert.strictEqual(payout, 0);
    });

    it('returns 0 if metadata is undefined', () => {
      const engine = new CoinFlipEngine();
      const session = { pointsBet: 100 };
      const payout = engine.settle({ session, metadata: undefined });
      assert.strictEqual(payout, 0);
    });

    it('returns 0 if outcome is LOST', () => {
      const engine = new CoinFlipEngine();
      const session = { pointsBet: 100 };
      const metadata = { outcome: 'LOST', side: 'heads', flip: 'tails', multiplierBps: 0 };
      const payout = engine.settle({ session, metadata });
      assert.strictEqual(payout, 0);
    });

    it('returns 0 if outcome is IN_PROGRESS (no win)', () => {
      const engine = new CoinFlipEngine();
      const session = { pointsBet: 100 };
      const metadata = { outcome: 'IN_PROGRESS' };
      const payout = engine.settle({ session, metadata });
      assert.strictEqual(payout, 0);
    });

    it('applies payoutWithEdge on WON outcome', () => {
      const engine = new CoinFlipEngine();
      const session = { pointsBet: 10 };
      const metadata = { outcome: 'WON', side: 'heads', flip: 'heads', multiplierBps: 20000 };
      const payout = engine.settle({ session, metadata });
      const expected = payoutWithEdge(10, 20000);
      assert.strictEqual(payout, expected);
      assert.strictEqual(payout, 19);
    });

    it('handles larger bet correctly', () => {
      const engine = new CoinFlipEngine();
      const session = { pointsBet: 1000 };
      const metadata = { outcome: 'WON', side: 'heads', flip: 'heads', multiplierBps: 20000 };
      const payout = engine.settle({ session, metadata });
      const expected = payoutWithEdge(1000, 20000);
      assert.strictEqual(payout, expected);
      // floor(1000 * 20000 * 9700 / 10000^2) = floor(1000 * 2 * 0.97) = floor(1940) = 1940
      assert.strictEqual(payout, 1940);
    });

    it('handles zero-bet edge case', () => {
      const engine = new CoinFlipEngine();
      const session = { pointsBet: 0 };
      const metadata = { outcome: 'WON', side: 'heads', flip: 'heads', multiplierBps: 20000 };
      const payout = engine.settle({ session, metadata });
      assert.strictEqual(payout, 0);
    });
  });

  describe('pure logic (no side effects)', () => {
    it('does not mutate metadata on processStep', () => {
      const engine = new CoinFlipEngine({ flip: () => 0 });
      const metadata = { outcome: 'IN_PROGRESS' };
      const originalMetadata = { ...metadata };

      engine.processStep({
        metadata,
        action: 'flip',
        payload: { side: 'heads' },
      });

      // Original metadata should not be modified
      assert.deepStrictEqual(metadata, originalMetadata);
    });

    it('does not mutate session on settle', () => {
      const engine = new CoinFlipEngine();
      const session = { pointsBet: 100 };
      const originalSession = { ...session };
      const metadata = { outcome: 'WON', side: 'heads', flip: 'heads', multiplierBps: 20000 };

      engine.settle({ session, metadata });

      // Session should not be modified
      assert.deepStrictEqual(session, originalSession);
    });
  });
});
