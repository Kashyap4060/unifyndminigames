'use strict';

/**
 * Abstract base for all game engines. A concrete engine encapsulates the
 * game-specific LOGIC only — it never touches the balance, the ledger, or the
 * database directly. The transactional services (initiate / process / settle)
 * own locking, money, and persistence and call these hooks at the right points.
 *
 * Contract for the three lifecycle hooks (all receive a `ctx` object and are
 * invoked inside a DB transaction, but must themselves be pure/synchronous and
 * do no I/O — they only compute and return values):
 *
 *   initiate(ctx)    -> initial `game_metadata` object to persist on the session
 *                       (or null). ctx: { game, session, params }
 *   processStep(ctx) -> { metadata, status, result } where:
 *                         metadata = the new game_metadata to persist,
 *                         status   = 'CONTINUE' | 'WIN' | 'LOSE',
 *                         result   = client-safe step outcome (NEVER leak hidden
 *                                    state such as future chamber positions).
 *                       ctx: { game, session, metadata, action, payload }
 *   settle(ctx)      -> authoritative payout (integer points to credit; 0 = loss),
 *                       derived from trusted server state (the stored metadata),
 *                       NEVER from client input. ctx: { game, session, metadata, result }
 *
 * To add a new game: subclass this, implement the three hooks, and register an
 * instance in src/games/index.js. No core files change.
 */
class BaseGameEngine {
  /** Stable key matching games_directory.game_key. Must be overridden. */
  get gameKey() {
    throw new Error(`${this.constructor.name} must override the gameKey getter`);
  }

  // eslint-disable-next-line no-unused-vars
  initiate(ctx) {
    throw new Error(`${this.constructor.name} must implement initiate(ctx)`);
  }

  // eslint-disable-next-line no-unused-vars
  processStep(ctx) {
    throw new Error(`${this.constructor.name} must implement processStep(ctx)`);
  }

  // eslint-disable-next-line no-unused-vars
  settle(ctx) {
    throw new Error(`${this.constructor.name} must implement settle(ctx)`);
  }
}

module.exports = { BaseGameEngine };
