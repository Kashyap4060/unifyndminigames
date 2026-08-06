'use strict';

const { withTransaction } = require('../db/withTransaction');
const { getEngine } = require('../engines/registry');
const { parseMetadata } = require('../db/sessionMetadata');
const {
  AppError,
  NotFoundError,
  ConflictError,
  ForbiddenError,
} = require('../errors');

// Absolute ceiling on a single payout: keeps the credited amount within the JS
// safe-integer range and is mirrored by a DB CHECK on game_sessions.payout.
const MAX_PAYOUT = 1_000_000_000_000; // 1e12

// Additional sanity ceiling relative to the stake, to bound the blast radius of
// a buggy/compromised engine. Deliberately generous so it never rejects a
// legitimate jackpot/fixed-prize game — for a 1-point bet this still allows a
// 10M payout — while catching absurd returns (e.g. 1e12 on a 50-point bet).
const MAX_PAYOUT_MULTIPLIER = 10_000_000; // 1e7 x stake

function assertValidPayout(payout, pointsBet) {
  // Basic validity first — so BigInt() below only ever runs on a real integer
  // (an engine returning NaN/undefined fails here with our clean error).
  const basicValid =
    typeof payout === 'number' &&
    Number.isSafeInteger(payout) &&
    payout >= 0 &&
    payout <= MAX_PAYOUT;
  const withinStakeCap =
    basicValid &&
    (pointsBet <= 0 || BigInt(payout) <= BigInt(pointsBet) * BigInt(MAX_PAYOUT_MULTIPLIER));

  if (!basicValid || !withinStakeCap) {
    throw new AppError('Game engine returned an invalid payout', {
      status: 500,
      code: 'INTERNAL_ERROR',
    });
  }
}

async function currentBalance(connection, userId) {
  const [rows] = await connection.execute(
    'SELECT points_balance FROM users WHERE user_id = ?',
    [userId],
  );
  return rows.length ? String(rows[0].points_balance) : null;
}

/**
 * Applies settlement to an ALREADY-LOCKED, ACTIVE session on the given
 * connection: computes the authoritative payout via the game engine, credits it
 * (with a CREDIT ledger row) and flips the session to SETTLED. Shared by the
 * public /settle path and the /process auto-settle path so both are atomic and
 * identical. Assumes the caller has locked the session row FOR UPDATE and
 * verified ownership + ACTIVE status.
 *
 * @returns {Promise<{payout: string, balanceAfter: string|null}>}
 */
async function applySettlement(connection, { userId, session, game, metadata, result = null }) {
  const engine = getEngine(game.game_key);
  const pointsBet = Number(session.points_bet);

  const payout = engine.settle({
    game: { gameId: Number(game.game_id), gameKey: game.game_key, gameType: game.game_type },
    session: {
      sessionId: session.session_id,
      userId,
      gameId: Number(session.game_id),
      pointsBet,
    },
    metadata,
    result,
  });
  assertValidPayout(payout, pointsBet);

  let balanceAfter;
  if (payout > 0) {
    const [users] = await connection.execute(
      'SELECT points_balance, status FROM users WHERE user_id = ? FOR UPDATE',
      [userId],
    );
    if (users.length === 0) {
      throw new NotFoundError('User not found');
    }
    if (users[0].status !== 'ACTIVE') {
      throw new ForbiddenError('User account is not active');
    }
    balanceAfter = (BigInt(users[0].points_balance) + BigInt(payout)).toString();
    await connection.execute(
      'UPDATE users SET points_balance = points_balance + ? WHERE user_id = ?',
      [payout, userId],
    );
    await connection.execute(
      `INSERT INTO points_ledger
         (user_id, session_id, entry_type, reason, amount, balance_after)
       VALUES (?, ?, 'CREDIT', 'GAME_PAYOUT', ?, ?)`,
      [userId, session.session_id, payout, balanceAfter],
    );
  } else {
    balanceAfter = await currentBalance(connection, userId);
  }

  const [upd] = await connection.execute(
    `UPDATE game_sessions
        SET status = 'SETTLED', payout = ?, settled_at = CURRENT_TIMESTAMP
      WHERE session_id = ? AND status = 'ACTIVE'`,
    [payout, session.session_id],
  );
  if (upd.affectedRows !== 1) {
    // Lost a race to another settlement; the transaction rolls back.
    throw new ConflictError('Session was already settled');
  }

  return { payout: String(payout), balanceAfter };
}

/**
 * Public /settle entry point. Settles a session directly (e.g. an explicit cash
 * out or a safety-net finalize). Idempotent: re-settling a SETTLED session
 * returns the stored payout without crediting again.
 *
 * @param {object} params
 * @param {number} params.userId
 * @param {string} params.sessionId
 * @param {object|null} [params.result]  Untrusted client payload for the engine.
 */
async function settleGameSession({ userId, sessionId, result = null }) {
  return withTransaction(async (connection) => {
    const [sessions] = await connection.execute(
      `SELECT session_id, user_id, game_id, points_bet, status, payout, game_metadata
         FROM game_sessions
        WHERE session_id = ?
        FOR UPDATE`,
      [sessionId],
    );
    if (sessions.length === 0) {
      throw new NotFoundError('Session not found');
    }
    const session = sessions[0];

    // Ownership — 404 (not 403) so another user's session id isn't revealed.
    if (Number(session.user_id) !== userId) {
      throw new NotFoundError('Session not found');
    }

    // Idempotent replay — already settled, return stored payout, no re-credit.
    if (session.status === 'SETTLED') {
      return {
        sessionId,
        status: 'SETTLED',
        payout: String(session.payout == null ? 0 : session.payout),
        balanceAfter: await currentBalance(connection, userId),
        idempotentReplay: true,
      };
    }
    if (session.status !== 'ACTIVE') {
      throw new ConflictError(`Session cannot be settled from status ${session.status}`);
    }

    const [games] = await connection.execute(
      'SELECT game_id, game_key, game_type FROM games_directory WHERE game_id = ? LIMIT 1',
      [session.game_id],
    );
    const metadata = parseMetadata(session.game_metadata);
    const { payout, balanceAfter } = await applySettlement(connection, {
      userId,
      session,
      game: games[0],
      metadata,
      result,
    });

    return { sessionId, status: 'SETTLED', payout, balanceAfter, idempotentReplay: false };
  });
}

module.exports = { settleGameSession, applySettlement, assertValidPayout, MAX_PAYOUT };
