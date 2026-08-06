'use strict';

const { randomInt } = require('crypto');
const { BaseGameEngine } = require('./BaseGameEngine');
const { ValidationError, ConflictError } = require('../errors');
const { BPS_SCALE, payoutWithEdge } = require('./payout');

// Configuration constants
const DEFAULT_KEY_COUNT = 5;
const MIN_KEY_COUNT = 2;
const MAX_KEY_COUNT = 10;

// Win multiplier: N:1 where N is the number of keys (fair odds for 1/N probability)
// Multiplier in basis points: keyCount * BPS_SCALE
// E.g., 5 keys → 5 * 10000 = 50000 bps = 5.0x

/**
 * Vault game engine. Single-step 1-of-N key pick game.
 * Server picks a hidden winning key (0 to keyCount-1). Player picks a key.
 * Win → N:1 multiplier (fair), lose → 0x. Payout uses payoutWithEdge (applies 3% house edge).
 */
class VaultEngine extends BaseGameEngine {
  /**
   * @param {object} [opts]
   * @param {(keyCount: number) => number} [opts.pickWinner]
   *        Injectable winner picker (returns integer in [0, keyCount)).
   *        Defaults to crypto.randomInt(keyCount).
   *        Tests inject deterministic picks; production uses the default.
   */
  constructor({ pickWinner = (keyCount) => randomInt(keyCount) } = {}) {
    super();
    this._pickWinner = pickWinner;
  }

  get gameKey() {
    return 'vault';
  }

  initiate({ params } = {}) {
    const keyCount = params && params.keys != null ? params.keys : DEFAULT_KEY_COUNT;

    if (!Number.isInteger(keyCount) || keyCount < MIN_KEY_COUNT || keyCount > MAX_KEY_COUNT) {
      throw new ValidationError(
        `keyCount must be an integer in [${MIN_KEY_COUNT}, ${MAX_KEY_COUNT}], got ${keyCount}`,
      );
    }

    // Pick the winning key and store it hidden
    const winningKey = this._pickWinner(keyCount);

    return {
      winningKey, // Server-side only, never revealed before the pick
      keyCount,
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
      throw new ValidationError(`Unknown action "${action}" for vault`);
    }

    if (payload == null || typeof payload.key !== 'number') {
      throw new ValidationError('payload.key is required and must be a number');
    }

    const { key } = payload;
    if (!Number.isInteger(key) || key < 0 || key >= metadata.keyCount) {
      throw new ValidationError(
        `key must be an integer in [0, ${metadata.keyCount - 1}]`,
      );
    }

    // Determine win/loss by comparing pick to winning key
    const win = key === metadata.winningKey;
    const multiplierBps = win ? metadata.keyCount * BPS_SCALE : 0;
    const outcome = win ? 'WON' : 'LOST';
    const status = win ? 'WIN' : 'LOSE';

    const next = {
      winningKey: metadata.winningKey,
      keyCount: metadata.keyCount,
      key,
      outcome,
      multiplierBps,
    };

    return {
      metadata: next,
      status,
      result: {
        win,
        revealedKey: metadata.winningKey,
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

module.exports = VaultEngine;
