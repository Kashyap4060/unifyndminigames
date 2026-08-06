'use strict';

const express = require('express');
const authenticate = require('../middleware/auth');
const { leaderboardRateLimiter } = require('../middleware/rateLimit');
const { validateLeaderboardQuery } = require('../validators/leaderboardQuery');
const { leaderboardService } = require('../leaderboard');

const router = express.Router();

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

/**
 * GET /api/leaderboard?period=global|daily|weekly&limit=100
 * Returns the top players for a period plus the authenticated caller's own
 * rank/score. Served from Redis when available, else from MySQL (see `source`).
 */
router.get(
  '/',
  authenticate,
  leaderboardRateLimiter,
  asyncHandler(async (req, res) => {
    const { userId } = req.auth;
    const { period, limit } = validateLeaderboardQuery(req.query);

    const { source, entries } = await leaderboardService.getTopPlayers(period, { limit });
    const [rank, score] = await Promise.all([
      leaderboardService.getPlayerRank(userId, period),
      leaderboardService.getPlayerScore(userId, period),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        period,
        source, // 'redis' | 'mysql' — surfaces degraded mode
        entries,
        me: { user_id: String(userId), rank, score },
      },
    });
  }),
);

module.exports = router;
