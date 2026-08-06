'use strict';

const { randomInt } = require('crypto');
const { BaseGameEngine } = require('./BaseGameEngine');
const { ValidationError, ConflictError } = require('../errors');
const { BPS_SCALE, payoutWithEdge } = require('./payout');

// --- Tunable game constants (a real deployment would move these to config) ---
const DEFAULT_TILES = 25;
const MIN_TILES = 2;
const MAX_TILES = 100;
const DEFAULT_MINES = 3;

const ACTION_REVEAL = 'reveal';
const ACTION_CASHOUT = 'cashout';

/**
 * Fisher-Yates shuffle using crypto RNG so the mine layout is unpredictable.
 * @returns {boolean[]} length `totalTiles`, exactly `mines` true (mined).
 */
function secureMineBuilder(totalTiles, mines) {
  const arr = Array.from({ length: totalTiles }, (_, i) => i < mines);
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Minesweeper (Diamond Hunt) engine. Bet is debited at initiate; the board is a
 * grid of `totalTiles` with `mines` hidden mines. Each safe tile revealed grows
 * a stored multiplier at fair odds (rising risk); cashing out (or revealing a
 * mine) settles the session. The mine layout is server-side only and never
 * returned to clients.
 */
class MinesweeperEngine extends BaseGameEngine {
  /**
   * @param {object} [opts]
   * @param {(totalTiles:number, mines:number)=>boolean[]} [opts.mineBuilder]
   *        Injectable layout builder (defaults to the secure crypto shuffle).
   *        Tests inject a deterministic builder; production uses the default.
   */
  constructor({ mineBuilder = secureMineBuilder } = {}) {
    super();
    this._mineBuilder = mineBuilder;
  }

  get gameKey() {
    return 'minesweeper';
  }

  initiate({ params }) {
    const totalTiles = params && params.tiles != null ? params.tiles : DEFAULT_TILES;
    const mines = params && params.mines != null ? params.mines : DEFAULT_MINES;

    if (!Number.isInteger(totalTiles) || totalTiles < MIN_TILES || totalTiles > MAX_TILES) {
      throw new ValidationError(`tiles must be an integer in [${MIN_TILES}, ${MAX_TILES}]`);
    }
    if (!Number.isInteger(mines) || mines < 1 || mines >= totalTiles) {
      throw new ValidationError('mines must be an integer in [1, tiles - 1]');
    }

    const tiles = this._mineBuilder(totalTiles, mines);
    return {
      tiles, // boolean[] — SERVER-ONLY, never returned to the client
      totalTiles,
      mines,
      revealed: [], // indexes of safely revealed tiles so far
      multiplierBps: BPS_SCALE, // 1.0000x
      outcome: 'IN_PROGRESS', // IN_PROGRESS | DEAD | CASHED_OUT
    };
  }

  processStep({ metadata, action, payload }) {
    if (!metadata) {
      throw new ConflictError('Session has no game state');
    }
    if (metadata.outcome !== 'IN_PROGRESS') {
      throw new ConflictError('Game is already over');
    }

    if (action === ACTION_CASHOUT) {
      const next = { ...metadata, outcome: 'CASHED_OUT' };
      return {
        metadata: next,
        status: 'WIN',
        result: {
          action: ACTION_CASHOUT,
          multiplier: next.multiplierBps / BPS_SCALE,
          revealedCount: next.revealed.length,
        },
      };
    }

    if (action !== ACTION_REVEAL) {
      throw new ValidationError(`Unknown action "${action}" for minesweeper`);
    }

    const tile = payload && payload.tile;
    if (!Number.isInteger(tile) || tile < 0 || tile >= metadata.totalTiles) {
      throw new ValidationError(`payload.tile must be an integer in [0, ${metadata.totalTiles - 1}]`);
    }
    if (metadata.revealed.includes(tile)) {
      throw new ValidationError('Tile already revealed');
    }

    const { tiles, totalTiles, mines, revealed, multiplierBps } = metadata;

    if (tiles[tile] === true) {
      const next = { ...metadata, outcome: 'DEAD' };
      return {
        metadata: next,
        status: 'LOSE',
        result: {
          action: ACTION_REVEAL,
          safe: false,
          multiplier: multiplierBps / BPS_SCALE,
          revealedCount: revealed.length,
        },
      };
    }

    // Safe reveal: grow the multiplier by the fair odds of this pick (rising risk).
    const remaining = totalTiles - revealed.length;
    const minesRemaining = mines;
    const safeRemaining = remaining - minesRemaining;
    const newMultiplierBps = Math.floor((multiplierBps * remaining) / safeRemaining);
    const newRevealed = [...revealed, tile];
    const allSafeFound = newRevealed.length === totalTiles - mines;
    const outcome = allSafeFound ? 'CASHED_OUT' : 'IN_PROGRESS';
    const status = allSafeFound ? 'WIN' : 'CONTINUE';

    const next = {
      ...metadata,
      revealed: newRevealed,
      multiplierBps: newMultiplierBps,
      outcome,
    };

    return {
      metadata: next,
      status,
      result: {
        action: ACTION_REVEAL,
        safe: true,
        multiplier: newMultiplierBps / BPS_SCALE,
        revealedCount: newRevealed.length,
        safeTilesLeft: totalTiles - mines - newRevealed.length,
      },
    };
  }

  settle({ session, metadata }) {
    if (!metadata || metadata.outcome === 'DEAD') {
      return 0; // mine hit, or no metadata — total loss
    }
    // CASHED_OUT, or IN_PROGRESS settled directly via /settle (cash out now):
    // payout = bet * multiplier * houseEdge, computed with BigInt for precision.
    return payoutWithEdge(session.pointsBet, metadata.multiplierBps);
  }
}

module.exports = MinesweeperEngine;
module.exports.secureMineBuilder = secureMineBuilder;
