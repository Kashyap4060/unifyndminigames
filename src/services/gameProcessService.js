'use strict';

const { withTransaction } = require('../db/withTransaction');
const { getEngine } = require('../engines/registry');
const { parseMetadata, serializeMetadata } = require('../db/sessionMetadata');
const { applySettlement } = require('./gameSettlementService');
const { NotFoundError, ConflictError } = require('../errors');

const TERMINAL_STATUSES = new Set(['WIN', 'LOSE']);

/**
 * Processes one game step for an active session. Locks the session, delegates
 * the step to the game engine, persists the updated metadata, and — when the
 * step is terminal (WIN/LOSE) — auto-settles the session atomically in the same
 * transaction (credit + ledger + status via the shared settlement core).
 *
 * @param {object} params
 * @param {number} params.userId          Authoritative id from the JWT.
 * @param {string} params.sessionId
 * @param {string} params.action          Engine-specific action (e.g. 'pull').
 * @param {object|null} [params.payload]   Untrusted client payload for the engine.
 * @returns {Promise<{sessionId:string, status:string, step:object,
 *                    settlement:{payout:string, balanceAfter:string|null}|null}>}
 */
async function processGameStep({ userId, sessionId, action, payload = null }) {
  return withTransaction(async (connection) => {
    // 1. Lock the session — serializes concurrent steps on the same session.
    const [sessions] = await connection.execute(
      `SELECT session_id, user_id, game_id, points_bet, status, game_metadata
         FROM game_sessions
        WHERE session_id = ?
        FOR UPDATE`,
      [sessionId],
    );
    if (sessions.length === 0) {
      throw new NotFoundError('Session not found');
    }
    const session = sessions[0];

    // 2. Ownership — 404 (not 403) so another user's session id isn't revealed.
    if (Number(session.user_id) !== userId) {
      throw new NotFoundError('Session not found');
    }
    if (session.status !== 'ACTIVE') {
      throw new ConflictError(`Session is not active (status: ${session.status})`);
    }

    // 3. Load the game and run the engine step (pure game logic, no I/O).
    const [games] = await connection.execute(
      'SELECT game_id, game_key, game_type FROM games_directory WHERE game_id = ? LIMIT 1',
      [session.game_id],
    );
    const game = games[0]; // FK guarantees this row exists
    const engine = getEngine(game.game_key);
    const metadata = parseMetadata(session.game_metadata);

    const step = engine.processStep({
      game: { gameId: Number(game.game_id), gameKey: game.game_key, gameType: game.game_type },
      session: {
        sessionId: session.session_id,
        userId,
        gameId: Number(session.game_id),
        pointsBet: Number(session.points_bet),
      },
      metadata,
      action,
      payload,
    });

    // 4. Persist the updated game state.
    await connection.execute(
      'UPDATE game_sessions SET game_metadata = ? WHERE session_id = ?',
      [serializeMetadata(step.metadata), sessionId],
    );

    // 5. Auto-settle on a terminal step (atomic with the state update above).
    let settlement = null;
    if (TERMINAL_STATUSES.has(step.status)) {
      settlement = await applySettlement(connection, {
        userId,
        session,
        game,
        metadata: step.metadata,
      });
    }

    return {
      sessionId,
      status: step.status,
      step: step.result, // client-safe; never the raw metadata
      settlement,
    };
  });
}

module.exports = { processGameStep };
