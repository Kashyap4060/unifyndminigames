'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { BPS_SCALE, HOUSE_EDGE_BPS, rawPayout, payoutWithEdge } = require('../../src/engines/payout');

describe('payout', () => {
  describe('constants', () => {
    it('BPS_SCALE is 10000', () => {
      assert.strictEqual(BPS_SCALE, 10000);
    });

    it('HOUSE_EDGE_BPS is 9700', () => {
      assert.strictEqual(HOUSE_EDGE_BPS, 9700);
    });
  });

  describe('rawPayout()', () => {
    it('computes floor(bet * multiplierBps / BPS_SCALE)', () => {
      assert.strictEqual(rawPayout(100, 10500), 105);
      assert.strictEqual(rawPayout(10, 20000), 20);
    });

    it('floors fractional results down', () => {
      // 3 * 15000 / 10000 = 4.5 -> floors to 4
      assert.strictEqual(rawPayout(3, 15000), 4);
    });

    it('returns 0 when multiplierBps is 0', () => {
      assert.strictEqual(rawPayout(100, 0), 0);
    });
  });

  describe('payoutWithEdge()', () => {
    it('computes floor(bet * multiplierBps * HOUSE_EDGE_BPS / BPS_SCALE^2)', () => {
      // 10 * 20000 * 9700 / 1e8 = 19.4 -> floors to 19
      assert.strictEqual(payoutWithEdge(10, 20000), 19);
      // 100 * 30000 * 9700 / 1e8 = 291
      assert.strictEqual(payoutWithEdge(100, 30000), 291);
    });

    it('returns 0 when multiplierBps is 0', () => {
      assert.strictEqual(payoutWithEdge(10, 0), 0);
    });

    it('preserves precision for large bets via BigInt (no float rounding loss)', () => {
      // 1_000_000_000 * 20000 * 9700 / 1e8 = 1_940_000_000 exactly
      assert.strictEqual(payoutWithEdge(1_000_000_000, 20000), 1_940_000_000);
    });
  });
});
