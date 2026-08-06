'use strict';

const { randomInt } = require('crypto');
const { BaseGameEngine } = require('./BaseGameEngine');
const { ValidationError, ConflictError } = require('../errors');
const { BPS_SCALE, payoutWithEdge } = require('./payout');

// --- Tunable game constants (a real deployment would move these to config) ---
const DEFAULT_CHAMBERS = 6;
const DEFAULT_BULLETS = 1;
const MIN_CHAMBERS = 2;
const MAX_CHAMBERS = 20;

/**
 * Fisher-Yates shuffle using crypto RNG so the chamber layout is unpredictable.
 * @returns {boolean[]} length `totalChambers`, exactly `bullets` true (loaded).
 */
function secureChamberBuilder(totalChambers, bullets) {
  const arr = Array.from({ length: totalChambers }, (_, i) => i < bullets);
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function countBullets(chambers, fromIndex) {
  let n = 0;
  for (let i = fromIndex; i < chambers.length; i += 1) {
    if (chambers[i]) n += 1;
  }
  return n;
}

/**
 * Russian Roulette engine. Bet is debited at initiate; each survived trigger
 * pull grows a stored multiplier; cashing out (or a fatal pull) settles the
 * session. The chamber layout is server-side only and never returned to clients.
 */
class RussianRouletteEngine extends BaseGameEngine {
  /**
   * @param {object} [opts]
   * @param {(total:number, bullets:number)=>boolean[]} [opts.chamberBuilder]
   *        Injectable layout builder (defaults to the secure crypto shuffle).
   *        Tests inject a deterministic builder; production uses the default.
   */
  constructor({ chamberBuilder = secureChamberBuilder } = {}) {
    super();
    this._buildChambers = chamberBuilder;
  }

  get gameKey() {
    return 'russian_roulette';
  }

  initiate({ params }) {
    const totalChambers = params && params.chambers != null ? params.chambers : DEFAULT_CHAMBERS;
    const bullets = params && params.bullets != null ? params.bullets : DEFAULT_BULLETS;

    if (!Number.isInteger(totalChambers) || totalChambers < MIN_CHAMBERS || totalChambers > MAX_CHAMBERS) {
      throw new ValidationError(`chambers must be an integer in [${MIN_CHAMBERS}, ${MAX_CHAMBERS}]`);
    }
    if (!Number.isInteger(bullets) || bullets < 1 || bullets >= totalChambers) {
      throw new ValidationError('bullets must be an integer in [1, chambers - 1]');
    }

    const chambers = this._buildChambers(totalChambers, bullets);
    return {
      chambers, // boolean[] — SERVER-ONLY, never returned to the client
      totalChambers,
      bullets,
      position: 0, // next chamber to pull
      pulls: 0, // successful pulls so far
      multiplierBps: BPS_SCALE, // 1.0000x
      outcome: 'IN_PROGRESS', // IN_PROGRESS | DEAD | CASHED_OUT
    };
  }

  processStep({ metadata, action }) {
    if (!metadata) {
      throw new ConflictError('Session has no game state');
    }
    if (metadata.outcome !== 'IN_PROGRESS') {
      throw new ConflictError('Game is already over');
    }

    if (action === 'cashout') {
      const next = { ...metadata, outcome: 'CASHED_OUT' };
      return {
        metadata: next,
        status: 'WIN',
        result: {
          action: 'cashout',
          pulls: next.pulls,
          multiplier: next.multiplierBps / BPS_SCALE,
        },
      };
    }

    if (action !== 'pull') {
      throw new ValidationError(`Unknown action "${action}" for russian_roulette`);
    }

    const pos = metadata.position;
    if (pos >= metadata.totalChambers) {
      throw new ConflictError('No chambers remaining');
    }

    const chambersRemaining = metadata.totalChambers - pos;
    const bulletsRemaining = countBullets(metadata.chambers, pos);
    const safeRemaining = chambersRemaining - bulletsRemaining;
    const isBullet = metadata.chambers[pos];

    if (isBullet) {
      const next = { ...metadata, position: pos + 1, outcome: 'DEAD' };
      return {
        metadata: next,
        status: 'LOSE',
        result: {
          action: 'pull',
          survived: false,
          chamber: 'bullet',
          pulls: next.pulls,
          multiplier: next.multiplierBps / BPS_SCALE,
        },
      };
    }

    // Survived: grow the multiplier by the fair odds of this pull (rising risk).
    const newMultiplierBps = Math.floor((metadata.multiplierBps * chambersRemaining) / safeRemaining);
    const position = pos + 1;
    const pulls = metadata.pulls + 1;
    // Surviving the final chamber forces a win (only reachable with bullets = 0,
    // which validation forbids, but kept as a defensive terminal).
    const outcome = position >= metadata.totalChambers ? 'CASHED_OUT' : 'IN_PROGRESS';
    const status = outcome === 'CASHED_OUT' ? 'WIN' : 'CONTINUE';

    const next = { ...metadata, position, pulls, multiplierBps: newMultiplierBps, outcome };
    return {
      metadata: next,
      status,
      result: {
        action: 'pull',
        survived: true,
        chamber: 'safe',
        pulls,
        chambersLeft: metadata.totalChambers - position,
        multiplier: newMultiplierBps / BPS_SCALE,
      },
    };
  }

  settle({ session, metadata }) {
    if (!metadata || metadata.outcome === 'DEAD') {
      return 0; // fatal pull — total loss
    }
    // CASHED_OUT, or IN_PROGRESS settled directly via /settle (cash out now):
    // payout = bet * multiplier * houseEdge, computed with BigInt for precision.
    return payoutWithEdge(session.pointsBet, metadata.multiplierBps);
  }
}

module.exports = RussianRouletteEngine;
module.exports.secureChamberBuilder = secureChamberBuilder;
