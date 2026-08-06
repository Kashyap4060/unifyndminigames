'use strict';

const { randomUUID } = require('crypto');
const pool = require('../db/pool');
const { withTransaction } = require('../db/withTransaction');
const { getEngine } = require('../engines/registry');
const { serializeMetadata } = require('../db/sessionMetadata');
const {
  NotFoundError,
  ConflictError,
  ForbiddenError,
  ValidationError,
  InsufficientFundsError,
} = require('../errors');

const ER_DUP_ENTRY = 1062;

// Internal sentinel: a concurrent request won the (user_id, idempotency_key)
// unique index. Not an AppError — handled entirely within this module.
const REPLAY_NEEDED = Symbol('idempotency_replay_needed');

/**
 * Looks up an existing session for a user's idempotency key. The `executor` may
 * be a transaction connection or the pool itself (autocommit read).
 *
 * SECURITY: always scoped by user_id so one user can never read or replay
 * another user's session via a colliding/guessed idempotency key.
 *
 * @returns {Promise<object|null>} the replay payload, or null if none exists.
 */
async function findByIdempotencyKey(executor, userId, idempotencyKey) {
  const [rows] = await executor.execute(
    `SELECT session_id, game_id, points_bet
       FROM game_sessions
      WHERE user_id = ? AND idempotency_key = ?
      LIMIT 1`,
    [userId, idempotencyKey],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    sessionId: row.session_id,
    gameId: Number(row.game_id),
    pointsBet: Number(row.points_bet),
    idempotentReplay: true,
  };
}

/**
 * The transactional core. Runs entirely inside one transaction with a FOR
 * UPDATE lock on the user's balance row. Throws REPLAY_NEEDED (via a tagged
 * error) if a concurrent request already created the session for this key.
 */
async function runInitiate({ userId, gameId, pointsBet, idempotencyKey, params }) {
  return withTransaction(async (connection) => {
    // 1. Idempotency fast-path (scoped to this user): a retried request returns
    //    the original session instead of creating a second one / double-charging.
    if (idempotencyKey) {
      const existing = await findByIdempotencyKey(connection, userId, idempotencyKey);
      if (existing) return existing;
    }

    // 2. Validate the target game. Config is effectively static, so a plain
    //    read (no lock) is sufficient.
    const [games] = await connection.execute(
      `SELECT game_id, game_key, game_type, status, min_bet, max_bet
         FROM games_directory
        WHERE game_id = ?
        LIMIT 1`,
      [gameId],
    );
    if (games.length === 0) {
      throw new NotFoundError('Game not found');
    }
    const game = games[0];
    if (game.status !== 'ACTIVE') {
      throw new ConflictError('Game is not currently available');
    }
    const minBet = BigInt(game.min_bet);
    const maxBet = BigInt(game.max_bet);
    const bet = BigInt(pointsBet);
    if (bet < minBet || bet > maxBet) {
      throw new ValidationError('points_bet is outside the allowed range for this game', [
        { field: 'points_bet', min: game.min_bet.toString(), max: game.max_bet.toString() },
      ]);
    }

    // 2b. Build the initial server-side game state via the engine (fails fast on
    //     bad params, before we take the balance lock). Never derived from — and
    //     never returned to — the client.
    const engine = getEngine(game.game_key);
    const initialMetadata = engine.initiate({
      game: { gameId: Number(game.game_id), gameKey: game.game_key, gameType: game.game_type },
      session: { userId, gameId: Number(game.game_id), pointsBet },
      params,
    });

    // 3. Lock the user's balance row. This is the critical section: concurrent
    //    bets for the same user serialize here, so two requests can never both
    //    read the pre-debit balance.
    const [users] = await connection.execute(
      `SELECT user_id, points_balance, status
         FROM users
        WHERE user_id = ?
        FOR UPDATE`,
      [userId],
    );
    if (users.length === 0) {
      throw new NotFoundError('User not found');
    }
    const user = users[0];
    if (user.status !== 'ACTIVE') {
      throw new ForbiddenError('User account is not active');
    }

    // 4. Funds check (BigInt — balances may exceed the JS safe integer range).
    const balance = BigInt(user.points_balance);
    if (balance < bet) {
      throw new InsufficientFundsError('Insufficient points balance', {
        balance: balance.toString(),
        required: bet.toString(),
      });
    }
    const balanceAfter = balance - bet;

    // 5. Guarded debit — defense in depth on top of the FOR UPDATE lock and the
    //    UNSIGNED + CHECK column constraints. affectedRows must be exactly 1.
    const [deduct] = await connection.execute(
      `UPDATE users
          SET points_balance = points_balance - ?
        WHERE user_id = ?
          AND points_balance >= ?`,
      [pointsBet, userId, pointsBet],
    );
    if (deduct.affectedRows !== 1) {
      // Should be unreachable given the lock + check above; treat as a race.
      throw new InsufficientFundsError('Insufficient points balance');
    }

    // 6. Create the session with a server-generated UUIDv4.
    const sessionId = randomUUID();
    try {
      await connection.execute(
        `INSERT INTO game_sessions
           (session_id, user_id, game_id, points_bet, status, idempotency_key, game_metadata)
         VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)`,
        [sessionId, userId, gameId, pointsBet, idempotencyKey, serializeMetadata(initialMetadata)],
      );
    } catch (err) {
      // A concurrent request won the (user_id, idempotency_key) unique index.
      // The whole transaction (including the debit above) is rolled back by
      // withTransaction, so no double-charge occurs. Signal the caller to
      // replay the winning session. A duplicate key can only surface here once
      // the winner has committed, so a fresh read is guaranteed to find it.
      if (err.errno === ER_DUP_ENTRY && idempotencyKey) {
        const replayErr = new Error('idempotency replay needed');
        replayErr[REPLAY_NEEDED] = true;
        throw replayErr;
      }
      throw err;
    }

    // 7. Immutable ledger entry (append-only). amount is signed: negative debit.
    await connection.execute(
      `INSERT INTO points_ledger
         (user_id, session_id, entry_type, reason, amount, balance_after)
       VALUES (?, ?, 'DEBIT', 'GAME_BET', ?, ?)`,
      [userId, sessionId, -pointsBet, balanceAfter.toString()],
    );

    return {
      sessionId,
      gameId,
      pointsBet,
      balanceAfter: balanceAfter.toString(),
      idempotentReplay: false,
    };
  });
}

/**
 * Atomically starts a game session: locks the user's balance row, verifies the
 * game and sufficient funds, debits the points, records the session and an
 * immutable ledger entry, and returns a freshly minted UUIDv4 session id.
 *
 * Concurrency safety is provided by FOR UPDATE row locking plus automatic
 * deadlock/lock-timeout retry inside withTransaction(). Duplicate submits with
 * the same idempotency key resolve to a single session.
 *
 * @param {object} params
 * @param {number} params.userId          Authoritative id from the JWT.
 * @param {number} params.gameId
 * @param {number} params.pointsBet
 * @param {string|null} [params.idempotencyKey]
 * @param {object|null} [params.params]    Optional engine init params (e.g. chambers/bullets).
 * @returns {Promise<{sessionId: string, gameId: number, pointsBet: number,
 *                    balanceAfter: string, idempotentReplay: boolean}>}
 */
async function initiateGameSession({ userId, gameId, pointsBet, idempotencyKey = null, params = null }) {
  try {
    return await runInitiate({ userId, gameId, pointsBet, idempotencyKey, params });
  } catch (err) {
    if (err && err[REPLAY_NEEDED]) {
      // The winning session is committed and visible; return it as a replay.
      const replay = await findByIdempotencyKey(pool, userId, idempotencyKey);
      if (replay) return replay;
      // Extremely unlikely (winner rolled back after we saw its lock).
      throw new ConflictError('Duplicate request could not be resolved; please retry');
    }
    throw err;
  }
}

module.exports = { initiateGameSession };
