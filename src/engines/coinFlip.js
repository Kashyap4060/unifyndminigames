'use strict';

const { randomInt } = require('crypto');
const { BaseGameEngine } = require('./BaseGameEngine');
const { ValidationError, ConflictError } = require('../errors');
const { BPS_SCALE, payoutWithEdge } = require('./payout');

// Win multiplier: 2.0x (double-or-nothing)
const WIN_MULTIPLIER_BPS = 2 * BPS_SCALE;

/**
 * Coin Flip engine. Single-step 50/50 double-or-nothing game.
 * Player picks heads or tails, server flips. Win → 2.0x, lose → 0x.
 * Payout uses payoutWithEdge (applies 3% house edge).
 */
class CoinFlipEngine extends BaseGameEngine {
  /**
   * @param {object} [opts]
   * @param {()=>number} [opts.flip]
   *        Injectable flip function (returns 0 or 1). Defaults to crypto.randomInt(2).
   *        Tests inject deterministic flips; production uses the default.
   */
  constructor({ flip = () => randomInt(2) } = {}) {
    super();
    this._flip = flip;
  }

  get gameKey() {
    return 'coin_flip';
  }

  initiate() {
    // No params needed for coin flip. Just return initial state.
    return {
      outcome: 'IN_PROGRESS',
    };
  }

  processStep({ metadata, action, payload }) {
    if (!metadata) {
      throw new ConflictError('Session has no game state');
    }

    if (metadata.outcome !== 'IN_PROGRESS') {
      throw new ConflictError('Game is already over');
    }

    if (action !== 'flip') {
      throw new ValidationError(`Unknown action "${action}" for coin_flip`);
    }

    if (!payload || typeof payload.side !== 'string') {
      throw new ValidationError('payload.side is required and must be a string');
    }

    const { side } = payload;
    if (side !== 'heads' && side !== 'tails') {
      throw new ValidationError('side must be "heads" or "tails"');
    }

    // Perform the flip: 0 → heads, 1 → tails.
    const n = this._flip();
    const flip = n === 0 ? 'heads' : 'tails';

    // Determine win/loss and set multiplier.
    const win = flip === side;
    const multiplierBps = win ? WIN_MULTIPLIER_BPS : 0; // 2.0x or 0x
    const outcome = win ? 'WON' : 'LOST';
    const status = win ? 'WIN' : 'LOSE';

    const next = {
      outcome,
      side,
      flip,
      multiplierBps,
    };

    return {
      metadata: next,
      status,
      result: {
        flip,
        win,
        multiplier: multiplierBps / BPS_SCALE,
      },
    };
  }

  settle({ session, metadata }) {
    if (!metadata || metadata.outcome !== 'WON') {
      return 0; // Loss or no metadata → total loss
    }
    // Win → payout with 3% house edge
    return payoutWithEdge(session.pointsBet, metadata.multiplierBps);
  }
}

module.exports = CoinFlipEngine;
