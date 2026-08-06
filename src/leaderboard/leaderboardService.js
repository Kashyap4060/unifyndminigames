'use strict';

const {
  PERIOD_TYPES,
  isValidPeriodType,
  redisKey,
  periodKeyValue,
  periodsFor,
  parseEntries,
} = require('./keys');
const { ValidationError } = require('../errors');

const DEFAULT_TOP_LIMIT = 100;
const MAX_TOP_LIMIT = 1000;

/**
 * Redis-backed live leaderboard with a MySQL fallback.
 *
 * Write path: persist to MySQL (durable, source of truth) FIRST, then update
 * Redis best-effort. A Redis write failure never fails the operation — the data
 * is safe in MySQL and Redis is reconciled by `rebuildFromDatabase()`.
 *
 * Read path: serve from Redis when available and warm; otherwise fall back to
 * MySQL so the app stays fully functional with Redis offline or cold.
 *
 * Dependency-injected (redis client, repository) so the fallback logic is
 * testable without live infrastructure.
 */
class LeaderboardService {
  /**
   * @param {object} deps
   * @param {import('ioredis').Redis|null} deps.redis  ioredis client, or null to run MySQL-only.
   * @param {import('./leaderboardRepository').LeaderboardRepository} deps.repository
   * @param {{daily:number, weekly:number}} [deps.ttl]  TTL seconds for daily/weekly keys.
   * @param {Console} [deps.logger]
   */
  constructor({ redis, repository, ttl = {}, logger = console }) {
    this.redis = redis || null;
    this.repository = repository;
    this.ttl = { daily: ttl.daily || 0, weekly: ttl.weekly || 0, global: 0 };
    this.logger = logger;
  }

  isRedisAvailable() {
    return Boolean(this.redis) && this.redis.status === 'ready';
  }

  ttlFor(periodType) {
    return this.ttl[periodType] || 0;
  }

  /** Set an absolute score across global/daily/weekly (Redis ZADD + MySQL upsert). */
  async addScore(userId, score, { now = new Date() } = {}) {
    assertUserId(userId);
    assertFiniteNumber(score, 'score');
    const periods = periodsFor(now);

    // Durable first — must succeed.
    await Promise.all(
      periods.map((p) => this.repository.upsertScore(p.type, p.periodKey, userId, score)),
    );

    // Cache best-effort.
    await this._pipelineAcross(periods, (pipe, p) => pipe.zadd(p.redisKey, score, userId));
  }

  /** Increment a score across all periods (Redis ZINCRBY + MySQL upsert-add). */
  async incrementScore(userId, delta, { now = new Date() } = {}) {
    assertUserId(userId);
    assertFiniteNumber(delta, 'delta');
    const periods = periodsFor(now);

    await Promise.all(
      periods.map((p) => this.repository.incrementScore(p.type, p.periodKey, userId, delta)),
    );

    await this._pipelineAcross(periods, (pipe, p) => pipe.zincrby(p.redisKey, delta, userId));
  }

  /**
   * Top-N players for a period, highest first. Serves from Redis (ZREVRANGE
   * WITHSCORES) when available and non-empty, else falls back to MySQL.
   * @returns {Promise<{source:'redis'|'mysql', entries:Array<{userId:string,score:number,rank:number}>}>}
   */
  async getTopPlayers(periodType = PERIOD_TYPES.GLOBAL, { limit = DEFAULT_TOP_LIMIT, now = new Date() } = {}) {
    assertPeriodType(periodType);
    const n = assertLimit(limit);
    const key = redisKey(periodType, now);
    const periodKey = periodKeyValue(periodType, now);

    if (this.isRedisAvailable()) {
      try {
        const flat = await this.redis.zrevrange(key, 0, n - 1, 'WITHSCORES');
        // A cold/empty key falls through to MySQL (the source of truth).
        if (flat && flat.length > 0) {
          return { source: 'redis', entries: parseEntries(flat) };
        }
      } catch (err) {
        this.logger.error(`[leaderboard] Redis read failed, falling back to MySQL: ${err.message}`);
      }
    }

    const rows = await this.repository.getTop(periodType, periodKey, n);
    return {
      source: 'mysql',
      entries: rows.map((r, i) => ({ userId: String(r.user_id), score: Number(r.score), rank: i + 1 })),
    };
  }

  /** A player's 1-based rank in a period (Redis ZREVRANK, else MySQL), or null. */
  async getPlayerRank(userId, periodType = PERIOD_TYPES.GLOBAL, { now = new Date() } = {}) {
    assertUserId(userId);
    assertPeriodType(periodType);
    const key = redisKey(periodType, now);

    if (this.isRedisAvailable()) {
      try {
        const rank = await this.redis.zrevrank(key, String(userId));
        if (rank !== null && rank !== undefined) return rank + 1; // ZREVRANK is 0-based
      } catch (err) {
        this.logger.error(`[leaderboard] Redis rank read failed, falling back: ${err.message}`);
      }
    }
    return this.repository.getRank(periodType, periodKeyValue(periodType, now), userId);
  }

  /** A player's score in a period (Redis ZSCORE, else MySQL), or null. */
  async getPlayerScore(userId, periodType = PERIOD_TYPES.GLOBAL, { now = new Date() } = {}) {
    assertUserId(userId);
    assertPeriodType(periodType);
    const key = redisKey(periodType, now);

    if (this.isRedisAvailable()) {
      try {
        const score = await this.redis.zscore(key, String(userId));
        if (score !== null && score !== undefined) return Number(score);
      } catch (err) {
        this.logger.error(`[leaderboard] Redis score read failed, falling back: ${err.message}`);
      }
    }
    return this.repository.getScore(periodType, periodKeyValue(periodType, now), userId);
  }

  /**
   * Rehydrate a Redis period key from MySQL (the source of truth). Call after
   * Redis recovers from an outage, or to warm a cold cache. Rebuilds atomically:
   * writes to a temp key, then renames over the live key.
   */
  async rebuildFromDatabase(periodType = PERIOD_TYPES.GLOBAL, { now = new Date(), limit = MAX_TOP_LIMIT } = {}) {
    assertPeriodType(periodType);
    if (!this.isRedisAvailable()) {
      this.logger.warn('[leaderboard] rebuild skipped — Redis unavailable');
      return 0;
    }
    const n = assertLimit(limit);
    const key = redisKey(periodType, now);
    const rows = await this.repository.getTop(periodType, periodKeyValue(periodType, now), n);
    if (rows.length === 0) return 0;

    const tmp = `${key}:rebuild:${process.pid}`;
    try {
      const pipe = this.redis.pipeline();
      pipe.del(tmp);
      for (const r of rows) pipe.zadd(tmp, Number(r.score), String(r.user_id));
      const ttl = this.ttlFor(periodType);
      if (ttl > 0) pipe.expire(tmp, ttl);
      pipe.rename(tmp, key); // atomic swap into place
      await pipe.exec();
      return rows.length;
    } catch (err) {
      this.logger.error(`[leaderboard] rebuild failed: ${err.message}`);
      try {
        await this.redis.del(tmp);
      } catch (_cleanupErr) {
        /* best effort */
      }
      return 0;
    }
  }

  /**
   * Runs `apply(pipe, period)` for each period in a single pipeline and applies
   * TTLs. Best-effort: logs and swallows failures so a Redis problem never
   * breaks a write already durably persisted in MySQL.
   * @private
   */
  async _pipelineAcross(periods, apply) {
    if (!this.isRedisAvailable()) {
      this.logger.warn('[leaderboard] Redis unavailable — cache write skipped (MySQL persisted)');
      return false;
    }
    try {
      const pipe = this.redis.pipeline();
      for (const p of periods) {
        apply(pipe, p);
        const ttl = this.ttlFor(p.type);
        if (ttl > 0) pipe.expire(p.redisKey, ttl);
      }
      await pipe.exec();
      return true;
    } catch (err) {
      this.logger.error(`[leaderboard] Redis cache write failed (MySQL persisted): ${err.message}`);
      return false;
    }
  }
}

function assertUserId(userId) {
  const n = Number(userId);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ValidationError('userId must be a positive integer');
  }
}

function assertFiniteNumber(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`${field} must be a finite number`);
  }
}

function assertPeriodType(periodType) {
  if (!isValidPeriodType(periodType)) {
    throw new ValidationError(`periodType must be one of global|daily|weekly`);
  }
}

function assertLimit(limit) {
  const n = Number(limit);
  if (!Number.isInteger(n) || n <= 0 || n > MAX_TOP_LIMIT) {
    throw new ValidationError(`limit must be an integer in [1, ${MAX_TOP_LIMIT}]`);
  }
  return n;
}

module.exports = { LeaderboardService, DEFAULT_TOP_LIMIT, MAX_TOP_LIMIT };
