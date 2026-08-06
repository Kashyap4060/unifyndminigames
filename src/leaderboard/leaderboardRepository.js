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

  /**
   * Repair a period's leaderboard_scores from the money source of truth: sum the
   * GAME_PAYOUT credits in points_ledger per user for the period's UTC window and
   * upsert the authoritative totals. Fixes any drift from a lost/failed increment.
   *
   * @param {string} periodType
   * @param {string} periodKey
   * @param {{start:string, end:string}|null} timeRange  null = all-time (global).
   * @returns {Promise<number>} number of users reconciled.
   */
  async reconcilePeriodFromLedger(periodType, periodKey, timeRange) {
    const conn = await this.pool.getConnection();
    try {
      // Interpret ledger timestamps in UTC to match the UTC-derived period window.
      await conn.query("SET time_zone = '+00:00'");

      let sql =
        `SELECT user_id, SUM(amount) AS total
           FROM points_ledger
          WHERE reason = 'GAME_PAYOUT' AND entry_type = 'CREDIT'`;
      const params = [];
      if (timeRange) {
        sql += ' AND created_at >= ? AND created_at < ?';
        params.push(timeRange.start, timeRange.end);
      }
      sql += ' GROUP BY user_id';

      const [rows] = await conn.execute(sql, params);
      if (rows.length === 0) return 0;

      await conn.beginTransaction();
      try {
        for (const r of rows) {
          await conn.execute(
            `INSERT INTO leaderboard_scores (period_type, period_key, user_id, score)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE score = VALUES(score)`,
            [periodType, periodKey, r.user_id, String(r.total)],
          );
        }
        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw err;
      }
      return rows.length;
    } finally {
      conn.release();
    }
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
