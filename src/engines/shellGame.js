'use strict';

const { randomInt } = require('crypto');
const { BaseGameEngine } = require('./BaseGameEngine');
const { ValidationError, ConflictError } = require('../errors');
const { BPS_SCALE, payoutWithEdge } = require('./payout');

// Win multiplier: 3.0x (fair odds for 1/3 probability)
const WIN_MULTIPLIER_BPS = 3 * BPS_SCALE;

/**
 * Shell Game engine. Single-step 1-of-3 pick game.
 * Server picks a hidden winning cup (0, 1, or 2). Player picks a cup.
 * Win → 3.0x, lose → 0x. Payout uses payoutWithEdge (applies 3% house edge).
 */
class ShellGameEngine extends BaseGameEngine {
  /**
   * @param {object} [opts]
   * @param {()=>number} [opts.pickWinner]
   *        Injectable winner picker (returns 0, 1, or 2). Defaults to crypto.randomInt(3).
   *        Tests inject deterministic picks; production uses the default.
   */
  constructor({ pickWinner = () => randomInt(3) } = {}) {
    super();
    this._pickWinner = pickWinner;
  }

  get gameKey() {
    return 'shell_game';
  }

  initiate() {
    // No params needed for shell game. Pick the winning cup and store it hidden.
    const winningCup = this._pickWinner();
    return {
      winningCup, // Server-side only, never revealed before the pick
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

    if (action !== 'pick') {
      throw new ValidationError(`Unknown action "${action}" for shell_game`);
    }

    if (payload == null || typeof payload.cup !== 'number') {
      throw new ValidationError('payload.cup is required and must be a number');
    }

    const { cup } = payload;
    if (!Number.isInteger(cup) || cup < 0 || cup > 2) {
      throw new ValidationError('cup must be an integer in {0, 1, 2}');
    }

    // Determine win/loss by comparing pick to winning cup
    const win = cup === metadata.winningCup;
    const multiplierBps = win ? WIN_MULTIPLIER_BPS : 0; // 3.0x or 0x
    const outcome = win ? 'WON' : 'LOST';
    const status = win ? 'WIN' : 'LOSE';

    const next = {
      winningCup: metadata.winningCup,
      pick: cup,
      outcome,
      multiplierBps,
    };

    return {
      metadata: next,
      status,
      result: {
        win,
        revealedCup: metadata.winningCup,
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

module.exports = ShellGameEngine;
