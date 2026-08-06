'use strict';

const { ValidationError } = require('../errors');

/** MySQL persistence for skill sessions and per-game high scores. */
class SkillRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async createSession(sessionId, userId, gameId, issuedAt) {
    await this.pool.execute(
      `INSERT INTO skill_sessions (session_id, user_id, game_id, status, issued_at)
       VALUES (?, ?, ?, 'STARTED', ?)`,
      [sessionId, userId, gameId, issuedAt],
    );
  }

  /** Lock a session row for a submit transaction. Returns the row or null. */
  async lockSession(connection, sessionId) {
    const [rows] = await connection.execute(
      `SELECT session_id, user_id, game_id, status, issued_at, score, reward
         FROM skill_sessions
        WHERE session_id = ?
        FOR UPDATE`,
      [sessionId],
    );
    return rows.length ? rows[0] : null;
  }

  /** Guarded STARTED -> SUBMITTED transition. Returns affectedRows (1 on success). */
  async markSubmitted(connection, sessionId, score, reward) {
    const [res] = await connection.execute(
      `UPDATE skill_sessions
          SET status = 'SUBMITTED', score = ?, reward = ?, submitted_at = CURRENT_TIMESTAMP
        WHERE session_id = ? AND status = 'STARTED'`,
      [score, reward, sessionId],
    );
    return res.affectedRows;
  }

  /** Keep-max upsert of a per-game best score (durable high-score store). */
  async upsertHighScore(connection, gameId, userId, score) {
    await connection.execute(
      `INSERT INTO skill_high_scores (game_id, user_id, best_score)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE best_score = GREATEST(best_score, VALUES(best_score))`,
      [gameId, userId, score],
    );
  }

  /** Top-N best scores for a game. Returns [{user_id, best_score}]. */
  async getHighScores(gameId, limit) {
    const n = Number(limit);
    if (!Number.isInteger(n) || n <= 0 || n > 1000) {
      throw new ValidationError('limit must be an integer in [1, 1000]');
    }
    const [rows] = await this.pool.execute(
      `SELECT user_id, best_score
         FROM skill_high_scores
        WHERE game_id = ?
        ORDER BY best_score DESC, user_id ASC
        LIMIT ${n}`,
      [gameId],
    );
    return rows;
  }
}

module.exports = { SkillRepository };
