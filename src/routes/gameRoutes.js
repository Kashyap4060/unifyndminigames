'use strict';

const express = require('express');
const authenticate = require('../middleware/auth');
const { initiateRateLimiter, settleRateLimiter, processRateLimiter } = require('../middleware/rateLimit');
const { validateInitiateGame } = require('../validators/initiateGame');
const { validateSettleGame } = require('../validators/settleGame');
const { validateProcessGame } = require('../validators/processGame');
const { initiateGameSession } = require('../services/gameSessionService');
const { settleGameSession } = require('../services/gameSettlementService');
const { processGameStep } = require('../services/gameProcessService');
const { leaderboardService } = require('../leaderboard');

const router = express.Router();

/**
 * Wraps an async handler so rejected promises reach the central error handler
 * instead of hanging the request.
 */
function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

/**
 * Best-effort: credit a fresh payout to the live leaderboards. Never fails the
 * request — the payout is already durably settled; the leaderboard is a
 * projection that self-heals via leaderboardService.rebuildFromDatabase().
 */
async function creditLeaderboard(userId, payout) {
  const points = Number(payout);
  if (!Number.isFinite(points) || points <= 0) return;
  try {
    await leaderboardService.incrementScore(userId, points);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[leaderboard] increment after settle failed: ${err.message}`);
  }
}

/**
 * POST /api/game/initiate
 * Starts a game session and debits the bet from the authenticated user.
 * Body: { game_id, points_bet, idempotency_key? }  (user_id comes from the JWT)
 */
router.post(
  '/initiate',
  authenticate,
  initiateRateLimiter,
  asyncHandler(async (req, res) => {
    const { userId } = req.auth;
    const { gameId, pointsBet, idempotencyKey, params } = validateInitiateGame(req.body);

    const result = await initiateGameSession({ userId, gameId, pointsBet, idempotencyKey, params });

    // 200 on an idempotent replay (nothing new created), 201 otherwise.
    return res.status(result.idempotentReplay ? 200 : 201).json({
      success: true,
      data: {
        session_id: result.sessionId,
        game_id: result.gameId,
        points_bet: result.pointsBet,
        balance_after: result.balanceAfter,
      },
    });
  }),
);

/**
 * POST /api/game/settle
 * Settles a session: computes the authoritative payout server-side, credits it,
 * and moves the session to SETTLED. Body: { session_id, result? }.
 * The payout is NEVER taken from the client.
 */
router.post(
  '/settle',
  authenticate,
  settleRateLimiter,
  asyncHandler(async (req, res) => {
    const { userId } = req.auth;
    const { sessionId, result } = validateSettleGame(req.body);

    const settlement = await settleGameSession({ userId, sessionId, result });

    // Update leaderboards only on the first (non-replay) settlement so a retried
    // /settle can't double-count winnings.
    if (!settlement.idempotentReplay) {
      await creditLeaderboard(userId, settlement.payout);
    }

    return res.status(200).json({
      success: true,
      data: {
        session_id: settlement.sessionId,
        status: settlement.status,
        payout: settlement.payout,
        balance_after: settlement.balanceAfter,
      },
    });
  }),
);

/**
 * POST /api/game/process
 * Advances one game step (engine-specific action, e.g. a trigger pull). Updates
 * server-side game state and, on a terminal step, auto-settles the session.
 * Body: { session_id, action, payload? }.
 */
router.post(
  '/process',
  authenticate,
  processRateLimiter,
  asyncHandler(async (req, res) => {
    const { userId } = req.auth;
    const { sessionId, action, payload } = validateProcessGame(req.body);

    const outcome = await processGameStep({ userId, sessionId, action, payload });

    // A terminal step auto-settles; credit the winnings to the leaderboards.
    // (A session can only reach a terminal step once, so this can't double-count.)
    if (outcome.settlement) {
      await creditLeaderboard(userId, outcome.settlement.payout);
    }

    return res.status(200).json({
      success: true,
      data: {
        session_id: outcome.sessionId,
        status: outcome.status, // CONTINUE | WIN | LOSE
        step: outcome.step,
        settlement: outcome.settlement
          ? { payout: outcome.settlement.payout, balance_after: outcome.settlement.balanceAfter }
          : null,
      },
    });
  }),
);

module.exports = router;
