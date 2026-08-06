'use strict';

const { randomInt } = require('crypto');
const { BaseGameEngine } = require('./BaseGameEngine');
const { ValidationError, ConflictError } = require('../errors');
const { BPS_SCALE, rawPayout } = require('./payout');

// --- Named constants (no bare magic numbers) ---
const START_BPS = BPS_SCALE; // 1.0000x starting multiplier
const TICK_NUMERATOR = 105; // each tick multiplies currentBps by 105/100 (+5%)
const TICK_DENOMINATOR = 100;
const INSTANT_BUST_PERCENT = 3; // house edge: 3% chance of an instant 1.00x bust
const MAX_CRASH_BPS = 100_000; // 10.0x cap on the crash point distribution

/**
 * Default crash-point distribution (house edge baked in — settlement uses
 * rawPayout, no additional edge applied at payout time):
 *   - With INSTANT_BUST_PERCENT% probability, the crash point is START_BPS
 *     (an instant bust at 1.00x — nobody can cash out in time).
 *   - Otherwise, the crash point is a uniformly random integer in
 *     [START_BPS + 1, MAX_CRASH_BPS], i.e. anywhere from just above 1.00x up
 *     to the 10.0x cap.
 * @returns {number} crash multiplier in bps, an integer >= START_BPS.
 */
function defaultCrashPoint() {
  const roll = randomInt(100); // uniform integer in [0, 99]
  if (roll < INSTANT_BUST_PERCENT) {
    return START_BPS;
  }
  // randomInt(min, max) is uniform over the half-open range [min, max).
  return randomInt(START_BPS + 1, MAX_CRASH_BPS + 1);
}

/**
 * Crash engine. Multi-step, tick-based rising-multiplier game. The crash
 * point is chosen (hidden) at initiate; each server-authoritative 'tick'
 * grows the current multiplier by a fixed factor until it either meets/
 * exceeds the hidden crash point (bust) or the player cashes out first.
 * There is no wall-clock — the client only animates what the server ticks
 * report. The hidden crash point (crashBps) is NEVER leaked in `result`.
 */
class CrashEngine extends BaseGameEngine {
  /**
   * @param {object} [opts]
   * @param {()=>number} [opts.crashPoint]
   *        Injectable hidden crash-point generator, returning an integer bps
   *        value >= BPS_SCALE. Defaults to defaultCrashPoint (crypto RNG).
   *        Tests inject a deterministic value; production uses the default.
   */
  constructor({ crashPoint = defaultCrashPoint } = {}) {
    super();
    this._crashPoint = crashPoint;
  }

  get gameKey() {
    return 'crash';
  }

  initiate() {
    const crashBps = this._crashPoint();
    return {
      crashBps, // number — SERVER-ONLY, never returned to the client
      currentBps: START_BPS,
      outcome: 'IN_PROGRESS', // IN_PROGRESS | CRASHED | CASHED_OUT
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
      const next = { crashBps: metadata.crashBps, currentBps: metadata.currentBps, outcome: 'CASHED_OUT' };
      return {
        metadata: next,
        status: 'WIN',
        result: {
          action: 'cashout',
          multiplier: next.currentBps / BPS_SCALE,
        },
      };
    }

    if (action !== 'tick') {
      throw new ValidationError(`Unknown action "${action}" for crash`);
    }

    const { crashBps, currentBps } = metadata;
    const nextBps = Math.floor((currentBps * TICK_NUMERATOR) / TICK_DENOMINATOR);

    if (nextBps >= crashBps) {
      // Bust: leave currentBps at its pre-bust value; do NOT reveal crashBps.
      const bustMetadata = { crashBps, currentBps, outcome: 'CRASHED' };
      return {
        metadata: bustMetadata,
        status: 'LOSE',
        result: {
          action: 'tick',
          crashed: true,
          multiplier: currentBps / BPS_SCALE,
        },
      };
    }

    const continueMetadata = { crashBps, currentBps: nextBps, outcome: 'IN_PROGRESS' };
    return {
      metadata: continueMetadata,
      status: 'CONTINUE',
      result: {
        action: 'tick',
        crashed: false,
        multiplier: nextBps / BPS_SCALE,
      },
    };
  }

  settle({ session, metadata }) {
    if (!metadata || metadata.outcome === 'CRASHED') {
      return 0; // no metadata, or busted — total loss
    }
    // CASHED_OUT, or IN_PROGRESS settled directly via /settle (cash out now):
    // the house edge is already baked into the crash-point distribution, so
    // settlement uses rawPayout (no additional edge applied here).
    return rawPayout(session.pointsBet, metadata.currentBps);
  }
}

module.exports = CrashEngine;
module.exports.defaultCrashPoint = defaultCrashPoint;
