'use strict';

const config = require('../config');
const pool = require('../db/pool');
const { createRedisClient } = require('../redis/client');
const { LeaderboardRepository } = require('./leaderboardRepository');
const { LeaderboardService } = require('./leaderboardService');
const { createReconciliationScheduler } = require('./scheduler');

/**
 * Wires the production leaderboard service: the shared MySQL pool as the durable
 * store, plus an ioredis client as the cache (only when REDIS_ENABLED). With
 * Redis disabled the service runs MySQL-only and every read/write still works.
 */
const redis = config.redis.enabled ? createRedisClient(config.redis) : null;
const repository = new LeaderboardRepository(pool);

const leaderboardService = new LeaderboardService({
  redis,
  repository,
  ttl: config.redis.ttl,
});

const reconciliationScheduler = createReconciliationScheduler({
  leaderboardService,
  schedules: config.leaderboard.reconcile.schedules,
});

/** Start the periodic reconciliation cron (call once at server startup). */
function startLeaderboardJobs() {
  if (!config.leaderboard.reconcile.enabled) return 0;
  return reconciliationScheduler.start();
}

/** Stop cron jobs and close the Redis connection during graceful shutdown. */
async function closeLeaderboard() {
  reconciliationScheduler.stop();
  if (redis) {
    try {
      await redis.quit();
    } catch (_err) {
      redis.disconnect();
    }
  }
}

module.exports = {
  leaderboardService,
  redisClient: redis,
  reconciliationScheduler,
  startLeaderboardJobs,
  closeLeaderboard,
};
