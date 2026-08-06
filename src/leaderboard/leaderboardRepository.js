'use strict';

const { ValidationError } = require('../errors');

/**
 * Durable MySQL persistence for leaderboards (the source of truth behind the
 * Redis cache). All methods are parameterized. `limit` is validated and inlined
 * as an integer because MySQL prepared statements are finicky with `LIMIT ?`.
 */
class LeaderboardRepository {
  constructor(pool) {
    this.pool = pool;
  }

  /** Set an absolute score (mirrors Redis ZADD). */
  async upsertScore(periodType, periodKey, userId, score) {
    await this.pool.execute(
      `INSERT INTO leaderboard_scores (period_type, period_key, user_id, score)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE score = VALUES(score)`,
      [periodType, periodKey, userId, score],
    );
  }

  /** Increment a score by delta, creating the row if absent (mirrors Redis ZINCRBY). */
  async incrementScore(periodType, periodKey, userId, delta) {
    await this.pool.execute(
      `INSERT INTO leaderboard_scores (period_type, period_key, user_id, score)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE score = score + VALUES(score)`,
      [periodType, periodKey, userId, delta],
    );
  }

  /** Top-N by score desc (the fallback for ZREVRANGE). Returns [{user_id, score}]. */
  async getTop(periodType, periodKey, limit) {
    const n = safeLimit(limit);
    const [rows] = await this.pool.execute(
      `SELECT user_id, score
         FROM leaderboard_scores
        WHERE period_type = ? AND period_key = ?
        ORDER BY score DESC, user_id ASC
        LIMIT ${n}`,
      [periodType, periodKey],
    );
    return rows;
  }

  /** 1-based rank of a user (count of strictly-higher scores + 1), or null. */
  async getRank(periodType, periodKey, userId) {
    const [rows] = await this.pool.execute(
      `SELECT 1 + (
                SELECT COUNT(*)
                  FROM leaderboard_scores AS higher
                 WHERE higher.period_type = l.period_type
                   AND higher.period_key = l.period_key
                   AND higher.score > l.score
              ) AS rnk
         FROM leaderboard_scores AS l
        WHERE l.period_type = ? AND l.period_key = ? AND l.user_id = ?`,
      [periodType, periodKey, userId],
    );
    return rows.length ? Number(rows[0].rnk) : null;
  }

  /** A user's score, or null if not on the board. */
  async getScore(periodType, periodKey, userId) {
    const [rows] = await this.pool.execute(
      `SELECT score FROM leaderboard_scores
        WHERE period_type = ? AND period_key = ? AND user_id = ?`,
      [periodType, periodKey, userId],
    );
    return rows.length ? Number(rows[0].score) : null;
  }
}

function safeLimit(limit) {
  const n = Number(limit);
  if (!Number.isInteger(n) || n <= 0 || n > 10000) {
    throw new ValidationError('limit must be an integer in [1, 10000]');
  }
  return n;
}

module.exports = { LeaderboardRepository, safeLimit };
