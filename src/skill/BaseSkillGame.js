'use strict';

/**
 * Abstract base for Part B skill/engagement games. Unlike Part A betting engines
 * (which compute the outcome), a skill game is played client-side and the server
 * VALIDATES a claimed result and awards a reward.
 *
 * Hooks (pure — no I/O; called by skillService):
 *   start(ctx)    -> optional public payload for the client (config/prompt).
 *                    ctx: { game, session:{sessionId,userId,gameId}, hiddenSeed }
 *                    NEVER put hidden answers derived from hiddenSeed in the return.
 *   validate(ctx) -> { valid, score, reward, reason? }
 *                    valid=false means the submission failed anti-cheat (implausible /
 *                    inconsistent) → no reward. A legitimate loss is valid=true with
 *                    reward 0. score/reward are non-negative integers; reward is capped
 *                    by skillService. ctx: { game, session, hiddenSeed, submission, elapsedMs }
 *
 * Add a skill game: subclass this, implement the hooks, register in src/skill/index.js.
 */
class BaseSkillGame {
  get gameKey() {
    throw new Error(`${this.constructor.name} must override the gameKey getter`);
  }

  // eslint-disable-next-line no-unused-vars, class-methods-use-this
  start(ctx) {
    return {};
  }

  // eslint-disable-next-line no-unused-vars
  validate(ctx) {
    throw new Error(`${this.constructor.name} must implement validate(ctx)`);
  }
}

module.exports = { BaseSkillGame };
