'use strict';

const express = require('express');
const helmet = require('helmet');
const gameRoutes = require('./routes/gameRoutes');
const leaderboardRoutes = require('./routes/leaderboardRoutes');
const skillRoutes = require('./routes/skillRoutes');
const errorHandler = require('./middleware/errorHandler');

// Side-effect require: registers per-game settlement resolvers at startup.
require('./games');

/**
 * Builds and returns the Express application. Kept separate from server startup
 * so it can be imported and exercised in tests without binding a port.
 */
function createApp() {
  const app = express();

  app.disable('x-powered-by');
  // Sensible security headers (HSTS, nosniff, frameguard, etc.).
  app.use(helmet());
  app.use(express.json({ limit: '16kb' }));

  app.get('/health', (_req, res) => res.json({ success: true, data: { status: 'ok' } }));

  app.use('/api/game', gameRoutes);
  app.use('/api/leaderboard', leaderboardRoutes);
  app.use('/api/skill', skillRoutes);

  // 404 for anything unmatched.
  app.use((_req, res) => {
    res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Route not found' },
    });
  });

  // Central error handler MUST be registered last.
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
