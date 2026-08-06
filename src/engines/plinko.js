'use strict';

const { randomInt } = require('crypto');
const { BaseGameEngine } = require('./BaseGameEngine');
const { AppError, ValidationError, ConflictError } = require('../errors');
const { BPS_SCALE, rawPayout } = require('./payout');

// --- Named constants (no bare magic numbers) ---
const ROWS = 8; // 8 peg rows → 9 slots (index = count of RIGHT bounces, 0..8)
const LEFT_STEP = 0;
const RIGHT_STEP = 1;
const LEFT_LABEL = 'L';
const RIGHT_LABEL = 'R';

/**
 * Slot -> multiplier (bps) lookup, indexed by number of RIGHT bounces out of
 * ROWS drops. Symmetric around the center slot; EV ≈ 0.98 under a fair
 * Binomial(8, 0.5) walk (house edge is baked into this distribution, so
 * settlement uses rawPayout — see settle() below). This is a documented,
 * tunable placeholder payout table.
 */
const SLOT_MULTIPLIERS_BPS = [120000, 30000, 15000, 7000, 2500, 7000, 15000, 30000, 120000];

/**
 * Plinko engine. Single-step (from the caller's point of view): one 'drop'
 * action performs all ROWS peg bounces server-side and resolves immediately
 * into a slot/multiplier. There is no hidden state after the drop — the
 * path and slot are the visible outcome.
 */
class PlinkoEngine extends BaseGameEngine {
  /**
   * @param {object} [opts]
   * @param {()=>number} [opts.dropStep]
   *        Injectable per-row bounce generator, returning 0 (left) or 1
   *        (right). Defaults to crypto.randomInt(2). Tests inject a
   *        deterministic sequence; production uses the default.
   */
  constructor({ dropStep = () => randomInt(2) } = {}) {
    super();
    this._dropStep = dropStep;
  }

  get gameKey() {
    return 'plinko';
  }

  initiate() {
    // No params needed for plinko. The ball drops at process time.
    return {
      outcome: 'IN_PROGRESS',
    };
  }

  processStep({ metadata, action }) {
    if (!metadata) {
      throw new ConflictError('Session has no game state');
    }
    if (metadata.outcome !== 'IN_PROGRESS') {
      throw new ConflictError('Game is already over');
    }
    if (action !== 'drop') {
      throw new ValidationError(`Unknown action "${action}" for plinko`);
    }

    const path = [];
    let rights = 0;
    for (let row = 0; row < ROWS; row += 1) {
      const step = this._dropStep();
      if (step === RIGHT_STEP) {
        rights += 1;
        path.push(RIGHT_LABEL);
      } else if (step === LEFT_STEP) {
        path.push(LEFT_LABEL);
      } else {
        // dropStep() misbehaving is an internal/RNG contract violation, not
        // client input — surface it as an internal error (500), not a 400.
        throw new AppError('Plinko RNG returned an invalid drop step', {
          status: 500,
          code: 'INTERNAL_ERROR',
        });
      }
    }

    const slot = rights;
    const multiplierBps = SLOT_MULTIPLIERS_BPS[slot];

    const next = {
      slot,
      multiplierBps,
      outcome: 'DROPPED',
    };

    return {
      metadata: next,
      status: 'WIN', // Plinko always pays the slot multiplier (may be a partial return below 1.0x)
      result: {
        slot,
        path,
        multiplier: multiplierBps / BPS_SCALE,
      },
    };
  }

  settle({ session, metadata }) {
    if (!metadata || metadata.outcome !== 'DROPPED') {
      return 0; // no metadata, or not yet resolved → no payout
    }
    // House edge is already baked into SLOT_MULTIPLIERS_BPS, so settlement
    // uses rawPayout (no additional edge applied here).
    return rawPayout(session.pointsBet, metadata.multiplierBps);
  }
}

module.exports = PlinkoEngine;
module.exports.SLOT_MULTIPLIERS_BPS = SLOT_MULTIPLIERS_BPS;
module.exports.ROWS = ROWS;
