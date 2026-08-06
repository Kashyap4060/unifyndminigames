'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const gameRoutes = require('./routes/gameRoutes');
const leaderboardRoutes = require('./routes/leaderboardRoutes');
const skillRoutes = require('./routes/skillRoutes');
const walletRoutes = require('./routes/walletRoutes');
const errorHandler = require('./middleware/errorHandler');

// Serve the prototype WebView client from the same origin as the API so its
// fetch() calls need no CORS. Open http://localhost:3000/play/?token=...
const CLIENT_DIR = path.join(__dirname, '..', 'client', 'russian-roulette');

// Side-effect require: registers per-game settlement resolvers at startup.
require('./games');

/**
 * Builds and returns the Express application. Kept separate from server startup
 * so it can be imported and exercised in tests without binding a port.
 */
function createApp() {
  const app = express();

  app.disable('x-powered-by');

  // Static demo client is served BEFORE helmet so its CDN <script>s aren't
  // blocked by the API's strict Content-Security-Policy. It's a self-contained
  // prototype page, not an API surface.
  app.get('/play', (_req, res) => res.sendFile(path.join(CLIENT_DIR, 'index.html')));
  app.use('/play', express.static(CLIENT_DIR));

  // Sensible security headers (HSTS, nosniff, frameguard, etc.) for the API.
  app.use(helmet());
  app.use(express.json({ limit: '16kb' }));

  app.get('/health', (_req, res) => res.json({ success: true, data: { status: 'ok' } }));

  app.use('/api/game', gameRoutes);
  app.use('/api/leaderboard', leaderboardRoutes);
  app.use('/api/skill', skillRoutes);
  app.use('/api/wallet', walletRoutes);

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
