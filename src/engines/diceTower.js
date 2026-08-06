'use strict';

const { randomInt } = require('crypto');
const { BaseGameEngine } = require('./BaseGameEngine');
const { ValidationError, ConflictError } = require('../errors');
const { BPS_SCALE, payoutWithEdge } = require('./payout');

// Win multipliers in basis points
const HIGH_LOW_MULTIPLIER_BPS = 24_000; // 2.4x for sum >= 8 or sum <= 6 (probability 15/36)
const SEVEN_MULTIPLIER_BPS = 60_000;   // 6.0x for sum === 7 (probability 6/36)

/**
 * Dice Tower engine. Single-step two-dice prediction game.
 * Player predicts 'high' (sum >= 8), 'low' (sum <= 6), or 'seven' (sum === 7).
 * Server rolls two dice. Win → pays configured multiplier, lose → 0x.
 * Payout uses payoutWithEdge (applies 3% house edge).
 */
class DiceTowerEngine extends BaseGameEngine {
  /**
   * @param {object} [opts]
   * @param {()=>number} [opts.rollDie]
   *        Injectable die roller (returns 1-6). Defaults to crypto.randomInt(1, 7).
   *        Tests inject deterministic dice; production uses the default.
   */
  constructor({ rollDie = () => randomInt(1, 7) } = {}) {
    super();
    this._rollDie = rollDie;
  }

  get gameKey() {
    return 'dice_tower';
  }

  initiate() {
    // No params needed for dice tower. Just return initial state.
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

    if (action !== 'roll') {
      throw new ValidationError(`Unknown action "${action}" for dice_tower`);
    }

    if (!payload || typeof payload.prediction !== 'string') {
      throw new ValidationError('payload.prediction is required and must be a string');
    }

    const { prediction } = payload;
    if (prediction !== 'high' && prediction !== 'low' && prediction !== 'seven') {
      throw new ValidationError('prediction must be "high", "low", or "seven"');
    }

    // Roll two dice
    const d1 = this._rollDie();
    const d2 = this._rollDie();
    const sum = d1 + d2;

    // Determine win/loss based on prediction
    let win = false;
    let multiplierBps = 0;

    if (prediction === 'high') {
      win = sum >= 8;
      multiplierBps = win ? HIGH_LOW_MULTIPLIER_BPS : 0;
    } else if (prediction === 'low') {
      win = sum <= 6;
      multiplierBps = win ? HIGH_LOW_MULTIPLIER_BPS : 0;
    } else if (prediction === 'seven') {
      win = sum === 7;
      multiplierBps = win ? SEVEN_MULTIPLIER_BPS : 0;
    }

    const outcome = win ? 'WON' : 'LOST';
    const status = win ? 'WIN' : 'LOSE';

    const next = {
      outcome,
      dice: [d1, d2],
      sum,
      prediction,
      multiplierBps,
    };

    return {
      metadata: next,
      status,
      result: {
        dice: [d1, d2],
        sum,
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

module.exports = DiceTowerEngine;
