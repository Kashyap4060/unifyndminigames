'use strict';

const express = require('express');
const config = require('../config');
const authenticate = require('../middleware/auth');
const {
  skillStartRateLimiter,
  skillSubmitRateLimiter,
  leaderboardRateLimiter,
} = require('../middleware/rateLimit');
const {
  validateSkillStart,
  validateSkillSubmit,
  validateSkillLeaderboardQuery,
} = require('../validators/skillGame');
const { skillService } = require('../skill');
const { aliasForUser } = require('../leaderboard/alias');

const router = express.Router();

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

/**
 * POST /api/skill/start
 * Begins a skill session; returns a signed seed token the client echoes at submit,
 * plus any public game config. Body: { game_id }.
 */
router.post(
  '/start',
  authenticate,
  skillStartRateLimiter,
  asyncHandler(async (req, res) => {
    const { userId } = req.auth;
    const { gameId } = validateSkillStart(req.body);
    const result = await skillService.start({ userId, gameId });
    const { sessionId, seedToken, ...publicPayload } = result;
    return res.status(201).json({
      success: true,
      data: { session_id: sessionId, seed_token: seedToken, ...publicPayload },
    });
  }),
);

/**
 * POST /api/skill/submit
 * Submits a played session for server-side validation + reward.
 * Body: { session_id, seed_token, submission }.
 */
router.post(
  '/submit',
  authenticate,
  skillSubmitRateLimiter,
  asyncHandler(async (req, res) => {
    const { userId } = req.auth;
    const { sessionId, seedToken, submission } = validateSkillSubmit(req.body);
    const outcome = await skillService.submit({ userId, sessionId, seedToken, submission });
    return res.status(200).json({
      success: true,
      data: {
        valid: outcome.valid,
        score: outcome.score,
        reward: outcome.reward,
        reason: outcome.reason,
        balance_after: outcome.balanceAfter,
        replay: outcome.replay,
      },
    });
  }),
);

/**
 * GET /api/skill/leaderboard?game_id=&limit=
 * Per-game high-score board with pseudonymous player aliases.
 */
router.get(
  '/leaderboard',
  authenticate,
  leaderboardRateLimiter,
  asyncHandler(async (req, res) => {
    const { userId } = req.auth;
    const { gameId, limit } = validateSkillLeaderboardQuery(req.query);
    const rows = await skillService.repository.getHighScores(gameId, limit);
    const secret = config.leaderboard.aliasSecret;
    const entries = rows.map((r, i) => ({
      rank: i + 1,
      score: Number(r.best_score),
      alias: aliasForUser(r.user_id, secret),
      isYou: String(r.user_id) === String(userId),
    }));
    return res.status(200).json({
      success: true,
      data: { game_id: gameId, entries, me: { alias: aliasForUser(userId, secret) } },
    });
  }),
);

module.exports = router;
