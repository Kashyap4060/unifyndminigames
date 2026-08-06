'use strict';

const config = require('../config');
const pool = require('../db/pool');
const { createRedisClient } = require('../redis/client');
const { LeaderboardRepository } = require('./leaderboardRepository');
const { LeaderboardService } = require('./leaderboardService');

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

/** Close the Redis connection during graceful shutdown. */
async function closeLeaderboard() {
  if (redis) {
    try {
      await redis.quit();
    } catch (_err) {
      redis.disconnect();
    }
  }
}

module.exports = { leaderboardService, redisClient: redis, closeLeaderboard };
