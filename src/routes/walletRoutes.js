'use strict';

const express = require('express');
const pool = require('../db/pool');
const authenticate = require('../middleware/auth');
const { leaderboardRateLimiter } = require('../middleware/rateLimit');
const { NotFoundError } = require('../errors');

const router = express.Router();

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

/**
 * GET /api/wallet — the authenticated user's current points balance, so a client
 * can show the real balance at launch (identity comes from the JWT).
 */
router.get(
  '/',
  authenticate,
  leaderboardRateLimiter,
  asyncHandler(async (req, res) => {
    const { userId } = req.auth;
    const [rows] = await pool.execute(
      'SELECT points_balance, status FROM users WHERE user_id = ?',
      [userId],
    );
    if (rows.length === 0) throw new NotFoundError('User not found');
    return res.status(200).json({
      success: true,
      data: {
        user_id: String(userId),
        balance: String(rows[0].points_balance),
        status: rows[0].status,
      },
    });
  }),
);

module.exports = router;
