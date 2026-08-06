'use strict';

const { createHash } = require('crypto');
const { BaseSkillGame } = require('../BaseSkillGame');

/**
 * Endless Runner (Part B skill game) — PROOF-OF-PLAY via server-side replay.
 *
 * A bounds-only check that trusts a self-reported score is idle-farmable: a
 * client can claim any score within the bounds without actually playing.
 * This engine instead:
 *   1. Derives a DETERMINISTIC obstacle course from the (public) sessionId —
 *      client and server compute the exact same course, so the client can
 *      render/play it and the server can independently verify it.
 *   2. Has the client submit its INPUT LOG (the ticks at which it jumped),
 *      not a score.
 *   3. RE-SIMULATES the run tick-by-tick against the course to derive the
 *      authoritative score (the tick the player crashed at, or full
 *      completion). A client cannot claim a score its inputs don't actually
 *      achieve.
 *   4. Bounds the simulated score against elapsed real time, so inputs must
 *      span real elapsed time (can't "complete" a 200-tick course in 5ms).
 *
 * The course itself is not secret — anti-cheat here is replay + time
 * plausibility, not hiding the course from the player.
 *
 * Pure: no DB/IO/Date.now/Math.random. Never mutates inputs.
 */

/** Number of ticks in the obstacle course. */
const COURSE_LENGTH = 200;

/** Minimum real milliseconds a player must spend per tick survived (anti-cheat floor). */
const TICK_MS = 100;

/** Target percentage of ticks (excluding the fixed-safe tick 0) that carry an obstacle. */
const OBSTACLE_DENSITY_PCT = 35;

/** Ticks survived required per 1 reward point. */
const SCORE_PER_REWARD_POINT = 4;

/**
 * Deterministically derive a boolean obstacle course from a public sessionId.
 * Same sessionId + courseLength always yields the same course, so the client
 * (which only knows the public sessionId) can render/play the identical
 * course the server will replay-verify against.
 *
 * Tick 0 is always obstacle-free (fair start — the player can't crash before
 * having a chance to react).
 *
 * @param {string} sessionId - public session identifier.
 * @param {number} courseLength - number of ticks to derive.
 * @returns {boolean[]} course - true at index t means an obstacle at tick t.
 */
function deriveCourse(sessionId, courseLength) {
  const course = new Array(courseLength);
  // Expand sessionId into as many hash-derived bytes as needed for one byte
  // per tick, chaining sha256 blocks so length isn't limited to 32 bytes.
  const bytes = [];
  let block = 0;
  while (bytes.length < courseLength) {
    const hash = createHash('sha256').update(`${sessionId}:${block}`).digest();
    for (let i = 0; i < hash.length; i += 1) bytes.push(hash[i]);
    block += 1;
  }

  const threshold = Math.floor((OBSTACLE_DENSITY_PCT / 100) * 256);
  for (let t = 0; t < courseLength; t += 1) {
    course[t] = t === 0 ? false : bytes[t] < threshold;
  }
  return course;
}

class EndlessRunnerEngine extends BaseSkillGame {
  constructor({ courseBuilder = deriveCourse, courseLength = COURSE_LENGTH, tickMs = TICK_MS } = {}) {
    super();
    this._courseBuilder = courseBuilder;
    this._courseLength = courseLength;
    this._tickMs = tickMs;
  }

  get gameKey() {
    return 'endless_runner';
  }

  /**
   * Public start payload: the course itself (0/1 per tick) plus the tick
   * duration, so the client can render and play the exact course the server
   * will later replay-verify. Not secret.
   */
  start(ctx) {
    const course = this._courseBuilder(ctx.session.sessionId, this._courseLength);
    return {
      course: course.map((hasObstacle) => (hasObstacle ? 1 : 0)),
      tickMs: this._tickMs,
    };
  }

  validate(ctx) {
    const { submission, elapsedMs } = ctx;
    const jumps = submission && submission.jumps;

    if (!isValidJumpsInput(jumps, this._courseLength)) {
      return { valid: false, score: 0, reward: 0, reason: 'malformed_input' };
    }

    const course = this._courseBuilder(ctx.session.sessionId, this._courseLength);
    const jumpedTicks = new Set(jumps);

    const score = simulateRun(course, jumpedTicks);

    if (score * this._tickMs > elapsedMs) {
      return { valid: false, score: 0, reward: 0, reason: 'implausible_time' };
    }

    return {
      valid: true,
      score,
      reward: Math.floor(score / SCORE_PER_REWARD_POINT),
      reason: score === this._courseLength ? 'completed' : 'crashed',
    };
  }
}

/**
 * Structural anti-cheat on the raw submission before any simulation runs.
 * @param {*} jumps - untrusted submission field.
 * @param {number} courseLength
 * @returns {boolean}
 */
function isValidJumpsInput(jumps, courseLength) {
  if (!Array.isArray(jumps)) return false;
  if (jumps.length > courseLength) return false;
  return jumps.every((tick) => Number.isInteger(tick) && tick >= 0 && tick < courseLength);
}

/**
 * Re-simulate the run tick-by-tick against the authoritative course. The
 * player crashes at the first tick that has an obstacle they didn't jump
 * over; the score is the number of ticks survived (the crash tick index).
 * If every obstacle is cleared, the score is the full course length.
 *
 * @param {boolean[]} course
 * @param {Set<number>} jumpedTicks
 * @returns {number} score - ticks survived (crash tick, or courseLength if completed).
 */
function simulateRun(course, jumpedTicks) {
  for (let t = 0; t < course.length; t += 1) {
    const hitsObstacle = course[t] && !jumpedTicks.has(t);
    if (hitsObstacle) return t;
  }
  return course.length;
}

module.exports = EndlessRunnerEngine;
module.exports.deriveCourse = deriveCourse;
module.exports.COURSE_LENGTH = COURSE_LENGTH;
module.exports.TICK_MS = TICK_MS;
module.exports.OBSTACLE_DENSITY_PCT = OBSTACLE_DENSITY_PCT;
module.exports.SCORE_PER_REWARD_POINT = SCORE_PER_REWARD_POINT;
