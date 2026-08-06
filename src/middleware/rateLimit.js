'use strict';

const rateLimit = require('express-rate-limit');

// Per-user throttle for balance-mutating endpoints. Applied AFTER
// authentication so the key is the authenticated user id (never spoofable),
// which also avoids IPv6 key-generation pitfalls of ip-based limiting.
//
// NOTE: this in-memory store is per-process. For a multi-instance deployment
// back it with a shared store (e.g. rate-limit-redis) so the limit is global.
const WINDOW_MS = 60_000; // 1 minute

function perUserLimiter(limit) {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `user:${req.auth.userId}`,
    handler: (_req, res) => {
      res.status(429).json({
        success: false,
        error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down' },
      });
    },
  });
}

// Starting a bet is more sensitive than settling; settle can fire once per play.
// Processing steps happens repeatedly during gameplay, so it gets a higher cap.
// Leaderboard reads are cheap (Redis) but polled often — a generous cap.
const initiateRateLimiter = perUserLimiter(30);
const settleRateLimiter = perUserLimiter(60);
const processRateLimiter = perUserLimiter(120);
const leaderboardRateLimiter = perUserLimiter(120);

module.exports = {
  initiateRateLimiter,
  settleRateLimiter,
  processRateLimiter,
  leaderboardRateLimiter,
  perUserLimiter,
};
