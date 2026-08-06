'use strict';

/**
 * Shared payout math for game engines. Multipliers are expressed in basis
 * points (BPS_SCALE = 10000 → 1.0000x). All arithmetic uses BigInt so large
 * balances/bets never lose precision, and the result is floored (house never
 * over-pays a fractional point).
 */

const BPS_SCALE = 10_000; // 10000 bps = 1.0x
const HOUSE_EDGE_BPS = 9_700; // 97% RTP (3% house edge)

/**
 * payout = floor(bet * multiplierBps / BPS_SCALE) — no house edge applied.
 * Use when the edge is already baked into the game's odds/distribution.
 */
function rawPayout(pointsBet, multiplierBps) {
  return Number((BigInt(pointsBet) * BigInt(multiplierBps)) / BigInt(BPS_SCALE));
}

/**
 * payout = floor(bet * multiplierBps * HOUSE_EDGE_BPS / BPS_SCALE^2) — applies
 * the house edge. Use for fair-odds multipliers that need the edge at payout.
 */
function payoutWithEdge(pointsBet, multiplierBps) {
  return Number(
    (BigInt(pointsBet) * BigInt(multiplierBps) * BigInt(HOUSE_EDGE_BPS)) /
      (BigInt(BPS_SCALE) * BigInt(BPS_SCALE)),
  );
}

module.exports = { BPS_SCALE, HOUSE_EDGE_BPS, rawPayout, payoutWithEdge };
