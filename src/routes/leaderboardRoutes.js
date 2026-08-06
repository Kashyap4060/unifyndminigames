'use strict';

const express = require('express');
const config = require('../config');
const authenticate = require('../middleware/auth');
const { leaderboardRateLimiter } = require('../middleware/rateLimit');
const { validateLeaderboardQuery } = require('../validators/leaderboardQuery');
const { leaderboardService } = require('../leaderboard');
const { aliasForUser } = require('../leaderboard/alias');

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

    const secret = config.leaderboard.aliasSecret;
    // Public entries expose an opaque, stable alias instead of the raw user_id —
    // no PK enumeration, no identity↔winnings linkage. `isYou` lets the caller
    // spot their own row without us echoing anyone's real id.
    const publicEntries = entries.map((e) => ({
      rank: e.rank,
      score: e.score,
      alias: aliasForUser(e.userId, secret),
      isYou: String(e.userId) === String(userId),
    }));

    return res.status(200).json({
      success: true,
      data: {
        period,
        source, // 'redis' | 'mysql' — surfaces degraded mode
        entries: publicEntries,
        me: { alias: aliasForUser(userId, secret), rank, score },
      },
    });
  }),
);

module.exports = router;
