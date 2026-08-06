'use strict';

/**
 * Loads and validates configuration from the environment at process startup.
 * Fails fast (throws) if a required secret or credential is missing, so the
 * service never boots into a half-configured, insecure state.
 */

function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function intWithDefault(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Environment variable ${name} must be a non-negative integer`);
  }
  return parsed;
}

function boolWithDefault(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

const config = Object.freeze({
  port: intWithDefault('PORT', 3000),
  db: Object.freeze({
    host: required('DB_HOST'),
    port: intWithDefault('DB_PORT', 3306),
    user: required('DB_USER'),
    password: required('DB_PASSWORD'),
    database: required('DB_NAME'),
    connectionLimit: intWithDefault('DB_CONNECTION_LIMIT', 10),
    lockWaitTimeout: intWithDefault('DB_LOCK_WAIT_TIMEOUT', 5),
  }),
  jwt: Object.freeze({
    secret: required('JWT_SECRET'),
    userIdClaim: process.env.JWT_USER_ID_CLAIM || 'sub',
    // Allow-list of accepted signing algorithms. Pinning this prevents
    // algorithm-confusion/downgrade attacks. Must match the token issuer.
    algorithms: Object.freeze(
      (process.env.JWT_ALGORITHMS || 'HS256')
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean),
    ),
  }),
  redis: Object.freeze({
    // When false, the leaderboard runs MySQL-only (still fully functional).
    enabled: boolWithDefault('REDIS_ENABLED', true),
    url: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    // A slow/hung Redis must fail fast so reads fall back to MySQL.
    commandTimeoutMs: intWithDefault('REDIS_COMMAND_TIMEOUT_MS', 250),
    ttl: Object.freeze({
      daily: intWithDefault('LEADERBOARD_DAILY_TTL', 172800), // 2 days
      weekly: intWithDefault('LEADERBOARD_WEEKLY_TTL', 777600), // 9 days
    }),
  }),
  leaderboard: Object.freeze({
    // Secret for deriving opaque public player aliases (never exposed to clients).
    // Falls back to JWT_SECRET when not set separately.
    aliasSecret: process.env.LEADERBOARD_ALIAS_SECRET || required('JWT_SECRET'),
  }),
});

module.exports = config;
