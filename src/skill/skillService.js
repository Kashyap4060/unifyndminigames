'use strict';

const { randomUUID } = require('crypto');
const { withTransaction } = require('../db/withTransaction');
const { getSkillGame } = require('./registry');
const { signToken, verifyToken, deriveHiddenSeed } = require('./seed');
const {
  AppError,
  NotFoundError,
  ConflictError,
  ForbiddenError,
  ValidationError,
} = require('../errors');

/**
 * Orchestrates the skill-game lifecycle:
 *   start()  — create a session, issue a signed seed token, return public config.
 *   submit() — validate the claimed result server-side (anti-cheat), award the
 *              reward atomically, and record the high score.
 */
class SkillService {
  constructor({ pool, repository, config, logger = console }) {
    this.pool = pool;
    this.repository = repository;
    this.config = config; // { seedSecret, submitWindowMs, maxReward }
    this.logger = logger;
  }

  async _loadGame(executor, gameId) {
    const [rows] = await executor.execute(
      'SELECT game_id, game_key, game_type, status FROM games_directory WHERE game_id = ? LIMIT 1',
      [gameId],
    );
    return rows.length ? rows[0] : null;
  }

  /**
   * Start a skill session. Returns { sessionId, seedToken, ...publicStartPayload }.
   */
  async start({ userId, gameId }) {
    const game = await this._loadGame(this.pool, gameId);
    if (!game) throw new NotFoundError('Game not found');
    if (game.status !== 'ACTIVE') throw new ConflictError('Game is not currently available');

    // Fail closed before creating a session if no engine handles this game.
    const engine = getSkillGame(game.game_key);

    const sessionId = randomUUID();
    const issuedAt = Date.now();
    await this.repository.createSession(sessionId, userId, gameId, issuedAt);

    const hiddenSeed = deriveHiddenSeed(sessionId, userId, gameId, this.config.seedSecret);
    const publicPayload = engine.start({
      game: { gameId: Number(game.game_id), gameKey: game.game_key, gameType: game.game_type },
      session: { sessionId, userId, gameId: Number(gameId) },
      hiddenSeed,
    }) || {};

    return {
      sessionId,
      seedToken: signToken(sessionId, issuedAt, this.config.seedSecret),
      ...publicPayload,
    };
  }

  /**
   * Submit a played session for validation + reward. Idempotent on replay of an
   * already-SUBMITTED session (returns the stored result, no second credit).
   */
  async submit({ userId, sessionId, seedToken, submission }) {
    return withTransaction(async (connection) => {
      const session = await this.repository.lockSession(connection, sessionId);
      if (!session) throw new NotFoundError('Session not found');
      // Ownership — 404 (not 403) so a foreign session id isn't revealed.
      if (Number(session.user_id) !== userId) throw new NotFoundError('Session not found');

      if (session.status === 'SUBMITTED') {
        return {
          valid: true,
          score: Number(session.score),
          reward: Number(session.reward),
          balanceAfter: null,
          replay: true,
        };
      }
      if (session.status !== 'STARTED') {
        throw new ConflictError(`Session cannot be submitted (status: ${session.status})`);
      }

      const elapsedMs = Date.now() - Number(session.issued_at);
      if (elapsedMs > this.config.submitWindowMs) {
        // Session is past its submit deadline; a sweeper may later mark EXPIRED.
        throw new ConflictError('Session has expired');
      }

      // Anti-forgery: the client must echo the exact token we issued.
      if (!verifyToken(sessionId, Number(session.issued_at), seedToken, this.config.seedSecret)) {
        throw new ValidationError('Invalid or tampered seed token');
      }

      const game = await this._loadGame(connection, session.game_id); // FK guarantees existence
      const engine = getSkillGame(game.game_key);
      const hiddenSeed = deriveHiddenSeed(sessionId, userId, session.game_id, this.config.seedSecret);

      const outcome = engine.validate({
        game: { gameId: Number(game.game_id), gameKey: game.game_key, gameType: game.game_type },
        session: { sessionId, userId, gameId: Number(session.game_id) },
        hiddenSeed,
        submission,
        elapsedMs,
      });

      const valid = outcome && outcome.valid === true;
      const score = sanitizeScore(outcome && outcome.score);
      const reward = valid ? this._sanitizeReward(outcome.reward) : 0;

      let balanceAfter = null;
      if (reward > 0) {
        balanceAfter = await this._creditReward(connection, userId, sessionId, reward);
      }

      const affected = await this.repository.markSubmitted(connection, sessionId, score, reward);
      if (affected !== 1) {
        // Lost a race to a concurrent submit; roll back.
        throw new ConflictError('Session was already submitted');
      }

      if (valid && score > 0) {
        await this.repository.upsertHighScore(connection, session.game_id, userId, score);
      }

      return {
        valid,
        score,
        reward,
        reason: (outcome && outcome.reason) || null,
        balanceAfter,
        replay: false,
      };
    });
  }

  /** @returns {Promise<string>} new balance (string) after crediting the reward. */
  async _creditReward(connection, userId, sessionId, reward) {
    const [users] = await connection.execute(
      'SELECT points_balance, status FROM users WHERE user_id = ? FOR UPDATE',
      [userId],
    );
    if (users.length === 0) throw new NotFoundError('User not found');
    if (users[0].status !== 'ACTIVE') throw new ForbiddenError('User account is not active');

    const balanceAfter = (BigInt(users[0].points_balance) + BigInt(reward)).toString();
    await connection.execute(
      'UPDATE users SET points_balance = points_balance + ? WHERE user_id = ?',
      [reward, userId],
    );
    // session_id references game_sessions (FK); skill sessions go in `reference`.
    await connection.execute(
      `INSERT INTO points_ledger
         (user_id, session_id, reference, entry_type, reason, amount, balance_after)
       VALUES (?, NULL, ?, 'CREDIT', 'SKILL_REWARD', ?, ?)`,
      [userId, sessionId, reward, balanceAfter],
    );
    return balanceAfter;
  }

  _sanitizeReward(reward) {
    if (typeof reward !== 'number' || !Number.isInteger(reward) || reward < 0 || reward > this.config.maxReward) {
      throw new AppError('Skill engine returned an invalid reward', {
        status: 500,
        code: 'INTERNAL_ERROR',
      });
    }
    return reward;
  }
}

function sanitizeScore(score) {
  if (typeof score !== 'number' || !Number.isInteger(score) || score < 0) {
    throw new AppError('Skill engine returned an invalid score', {
      status: 500,
      code: 'INTERNAL_ERROR',
    });
  }
  return score;
}

module.exports = { SkillService };
