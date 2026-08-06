'use strict';

const config = require('./config');
const pool = require('./db/pool');
const { createApp } = require('./app');
const { closeLeaderboard } = require('./leaderboard');

const app = createApp();
const server = app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`Gaming economy engine listening on port ${config.port}`);
});

/**
 * Graceful shutdown: stop accepting new connections, then drain the DB pool so
 * in-flight transactions are not cut mid-commit.
 */
async function shutdown(signal) {
  // eslint-disable-next-line no-console
  console.log(`Received ${signal}, shutting down...`);
  server.close(async () => {
    try {
      await closeLeaderboard();
      await pool.end();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Error during shutdown:', err.message);
    } finally {
      process.exit(0);
    }
  });

  // Force-exit if graceful shutdown stalls.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = server;
