'use strict';

const { randomInt } = require('crypto');
const { BaseGameEngine } = require('./BaseGameEngine');
const { ValidationError, ConflictError } = require('../errors');
const { BPS_SCALE, payoutWithEdge } = require('./payout');

// Configuration constants
const DEFAULT_ZONES = 3;
const MIN_ZONES = 2;
const MAX_ZONES = 6;

/**
 * Penalty Shootout game engine. Single-step goal/save prediction game.
 * Server picks a hidden goalie dive zone (0 to zones-1). Player shoots at a zone.
 * Goal (score) → zones:(zones-1) multiplier (fair; e.g. 3 zones → 1.5x), save (miss) → 0x.
 * Payout uses payoutWithEdge (applies 3% house edge).
 */
class PenaltyShootoutEngine extends BaseGameEngine {
  /**
   * @param {object} [opts]
   * @param {(zones: number) => number} [opts.pickDive]
   *        Injectable goalie dive picker (returns integer in [0, zones)).
   *        Defaults to crypto.randomInt(zones).
   *        Tests inject deterministic picks; production uses the default.
   */
  constructor({ pickDive = (zones) => randomInt(zones) } = {}) {
    super();
    this._pickDive = pickDive;
  }

  get gameKey() {
    return 'penalty_shootout';
  }

  initiate({ params } = {}) {
    const zones = params && params.zones != null ? params.zones : DEFAULT_ZONES;

    if (!Number.isInteger(zones) || zones < MIN_ZONES || zones > MAX_ZONES) {
      throw new ValidationError(
        `zones must be an integer in [${MIN_ZONES}, ${MAX_ZONES}], got ${zones}`,
      );
    }

    // Pick the goalie dive zone and store it hidden
    const goalieZone = this._pickDive(zones);

    return {
      goalieZone, // Server-side only, never revealed before the shot
      zones,
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

    if (action !== 'shoot') {
      throw new ValidationError(`Unknown action "${action}" for penalty_shootout`);
    }

    if (payload == null || typeof payload.zone !== 'number') {
      throw new ValidationError('payload.zone is required and must be a number');
    }

    const { zone } = payload;
    if (!Number.isInteger(zone) || zone < 0 || zone >= metadata.zones) {
      throw new ValidationError(
        `zone must be an integer in [0, ${metadata.zones - 1}]`,
      );
    }

    // Determine goal/save by comparing shoot zone to goalie dive zone
    const goal = zone !== metadata.goalieZone;
    const multiplierBps = goal ? Math.floor((metadata.zones * BPS_SCALE) / (metadata.zones - 1)) : 0;
    const outcome = goal ? 'WON' : 'LOST';
    const status = goal ? 'WIN' : 'LOSE';

    const next = {
      goalieZone: metadata.goalieZone,
      zones: metadata.zones,
      zone,
      outcome,
      multiplierBps,
    };

    return {
      metadata: next,
      status,
      result: {
        goal,
        goalieZone: metadata.goalieZone,
        multiplier: multiplierBps / BPS_SCALE,
      },
    };
  }

  settle({ session, metadata }) {
    if (!metadata || metadata.outcome !== 'WON') {
      return 0; // Loss or no metadata → total loss
    }
    // Goal → payout with 3% house edge
    return payoutWithEdge(session.pointsBet, metadata.multiplierBps);
  }
}

module.exports = PenaltyShootoutEngine;
