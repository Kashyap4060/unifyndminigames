'use strict';

const { randomInt } = require('crypto');
const { BaseGameEngine } = require('./BaseGameEngine');
const { ValidationError, ConflictError } = require('../errors');
const { BPS_SCALE, payoutWithEdge } = require('./payout');

// Configuration constants
const DEFAULT_RACERS = 6;
const MIN_RACERS = 2;
const MAX_RACERS = 12;

/**
 * Derby game engine. Single-step 1-of-N racer pick game.
 * Server picks a hidden winning racer (0 to racers-1). Player picks a racer.
 * Win → N:1 multiplier (fair), lose → 0x. Payout uses payoutWithEdge (applies 3% house edge).
 */
class DerbyEngine extends BaseGameEngine {
  /**
   * @param {object} [opts]
   * @param {(racers: number) => number} [opts.pickWinner]
   *        Injectable winner picker (returns integer in [0, racers)).
   *        Defaults to crypto.randomInt(racers).
   *        Tests inject deterministic picks; production uses the default.
   */
  constructor({ pickWinner = (racers) => randomInt(racers) } = {}) {
    super();
    this._pickWinner = pickWinner;
  }

  get gameKey() {
    return 'derby';
  }

  initiate({ params } = {}) {
    // Determine racers from params or use default
    let racers = DEFAULT_RACERS;
    if (params && params.racers != null) {
      racers = params.racers;
    }

    // Validate: racers must be an integer in [2, 12]
    if (!Number.isInteger(racers) || racers < MIN_RACERS || racers > MAX_RACERS) {
      throw new ValidationError(
        `racers must be an integer in [${MIN_RACERS}, ${MAX_RACERS}], got ${racers}`,
      );
    }

    // Pick the winning racer and store it hidden
    const winner = this._pickWinner(racers);

    return {
      winner, // Server-side only, never revealed before the bet
      racers,
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

    if (action !== 'bet') {
      throw new ValidationError(`Unknown action "${action}" for derby`);
    }

    if (payload == null || typeof payload.racer !== 'number') {
      throw new ValidationError('payload.racer is required and must be a number');
    }

    const { racer } = payload;
    if (!Number.isInteger(racer) || racer < 0 || racer >= metadata.racers) {
      throw new ValidationError(
        `racer must be an integer in [0, ${metadata.racers - 1}]`,
      );
    }

    // Determine win/loss by comparing pick to winning racer
    const win = racer === metadata.winner;
    const multiplierBps = win ? metadata.racers * BPS_SCALE : 0;
    const outcome = win ? 'WON' : 'LOST';
    const status = win ? 'WIN' : 'LOSE';

    const next = {
      winner: metadata.winner,
      racers: metadata.racers,
      racer,
      outcome,
      multiplierBps,
    };

    return {
      metadata: next,
      status,
      result: {
        win,
        winner: metadata.winner,
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

module.exports = DerbyEngine;
