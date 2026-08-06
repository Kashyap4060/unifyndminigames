'use strict';

const Redis = require('ioredis');

/**
 * Builds a resilient ioredis client tuned for graceful degradation:
 *
 * - `enableOfflineQueue: false` — when Redis is down, commands REJECT immediately
 *   instead of queueing indefinitely, so callers fail fast to the MySQL fallback.
 * - `commandTimeout` — a slow/hung Redis can't stall a request; it errors and we
 *   fall back.
 * - `maxRetriesPerRequest: 1` — don't spend a request's latency budget retrying.
 * - `retryStrategy` — the connection itself keeps reconnecting in the background
 *   with capped backoff, so the cache heals automatically once Redis returns.
 *
 * The 'error' listener is mandatory: ioredis emits 'error' on every failed
 * (re)connection attempt, and an unhandled 'error' event would crash the process.
 */
function createRedisClient(config, logger = console) {
  const client = new Redis(config.url, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: config.commandTimeoutMs,
    retryStrategy: (times) => Math.min(times * 200, 2000),
    reconnectOnError: () => true,
  });

  client.on('error', (err) => logger.error(`[redis] ${err.message}`));
  client.on('ready', () => logger.log('[redis] ready'));
  client.on('end', () => logger.warn('[redis] connection closed'));

  return client;
}

/** True when the client is connected and able to serve commands. */
function isRedisReady(client) {
  return Boolean(client) && client.status === 'ready';
}

module.exports = { createRedisClient, isRedisReady };
