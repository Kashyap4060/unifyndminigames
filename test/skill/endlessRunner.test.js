'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const EndlessRunnerEngine = require('../../src/skill/games/endlessRunner');
const { deriveCourse, COURSE_LENGTH, TICK_MS, SCORE_PER_REWARD_POINT } = EndlessRunnerEngine;

function makeCtx({ sessionId = 'sess-1', jumps, elapsedMs }) {
  return {
    game: { gameId: 1, gameKey: 'endless_runner', gameType: 'SKILL' },
    session: { sessionId, userId: 1, gameId: 1 },
    hiddenSeed: 'deadbeef',
    submission: { jumps },
    elapsedMs,
  };
}

describe('EndlessRunnerEngine', () => {
  it('has the expected gameKey', () => {
    const engine = new EndlessRunnerEngine();
    assert.equal(engine.gameKey, 'endless_runner');
  });

  describe('start()', () => {
    it('returns the public course (0/1 per tick) and tickMs of the right length', () => {
      const engine = new EndlessRunnerEngine();
      const result = engine.start({ game: {}, session: { sessionId: 'sess-1' }, hiddenSeed: 'x' });
      assert.equal(result.course.length, COURSE_LENGTH);
      assert.equal(result.tickMs, TICK_MS);
      result.course.forEach((tick) => assert.ok(tick === 0 || tick === 1));
    });

    it('tick 0 is always obstacle-free (fair start)', () => {
      const engine = new EndlessRunnerEngine();
      const result = engine.start({ game: {}, session: { sessionId: 'any-session-id' }, hiddenSeed: 'x' });
      assert.equal(result.course[0], 0);
    });
  });

  describe('deriveCourse()', () => {
    it('is deterministic: same sessionId + length -> same course', () => {
      const courseA = deriveCourse('sess-abc', 200);
      const courseB = deriveCourse('sess-abc', 200);
      assert.deepEqual(courseA, courseB);
    });

    it('is public/reproducible from only the sessionId (no hidden seed needed)', () => {
      const course = deriveCourse('sess-abc', 50);
      assert.equal(course.length, 50);
      assert.equal(course[0], false);
      // Reproducing with the same public input yields the identical course.
      assert.deepEqual(deriveCourse('sess-abc', 50), course);
    });

    it('produces different courses for different sessionIds', () => {
      const courseA = deriveCourse('sess-abc', 200);
      const courseB = deriveCourse('sess-xyz', 200);
      assert.notDeepEqual(courseA, courseB);
    });
  });

  describe('validate() — completed run', () => {
    it('jumping every obstacle completes the course with the full score', () => {
      const fixedCourse = [false, true, false, true, false];
      const engine = new EndlessRunnerEngine({
        courseBuilder: () => fixedCourse,
        courseLength: fixedCourse.length,
        tickMs: 100,
      });
      const result = engine.validate(makeCtx({ jumps: [1, 3], elapsedMs: 1_000_000 }));
      assert.deepEqual(result, {
        valid: true,
        score: 5,
        reward: Math.floor(5 / SCORE_PER_REWARD_POINT),
        reason: 'completed',
      });
    });
  });

  describe('validate() — crash', () => {
    it('missing a jump at an obstacle tick crashes at that tick (hand-computed)', () => {
      // course: [false,false,true,false,true]; jumps [2] clears tick 2's
      // obstacle but tick 4's obstacle is never jumped -> crash at tick 4.
      const fixedCourse = [false, false, true, false, true];
      const engine = new EndlessRunnerEngine({
        courseBuilder: () => fixedCourse,
        courseLength: fixedCourse.length,
        tickMs: 100,
      });
      const result = engine.validate(makeCtx({ jumps: [2], elapsedMs: 1_000_000 }));
      assert.equal(result.valid, true);
      assert.equal(result.score, 4);
      assert.equal(result.reason, 'crashed');
      assert.equal(result.reward, Math.floor(4 / SCORE_PER_REWARD_POINT));
    });

    it('crashing immediately at tick 0 obstacle yields score 0 (if course allowed it)', () => {
      // tick 0 is never an obstacle via deriveCourse, but an injected
      // courseBuilder can still exercise the t=0 crash path directly.
      const fixedCourse = [true, false];
      const engine = new EndlessRunnerEngine({
        courseBuilder: () => fixedCourse,
        courseLength: fixedCourse.length,
        tickMs: 100,
      });
      const result = engine.validate(makeCtx({ jumps: [], elapsedMs: 1_000_000 }));
      assert.equal(result.valid, true);
      assert.equal(result.score, 0);
      assert.equal(result.reason, 'crashed');
      assert.equal(result.reward, 0);
    });

    it('duplicate jump indices at the same tick are deduped without affecting the result', () => {
      const fixedCourse = [false, false, true, false, true];
      const engine = new EndlessRunnerEngine({
        courseBuilder: () => fixedCourse,
        courseLength: fixedCourse.length,
        tickMs: 100,
      });
      const result = engine.validate(makeCtx({ jumps: [2, 2, 2], elapsedMs: 1_000_000 }));
      assert.equal(result.score, 4);
      assert.equal(result.reason, 'crashed');
    });
  });

  describe('validate() — time plausibility', () => {
    const fixedCourse = new Array(10).fill(false); // no obstacles -> always completes at score 10

    it('rejects a high score reached in an implausibly short elapsed time', () => {
      const engine = new EndlessRunnerEngine({
        courseBuilder: () => fixedCourse,
        courseLength: fixedCourse.length,
        tickMs: 100,
      });
      // score will be 10; 10 * 100 = 1000 > 500ms elapsed -> implausible.
      const result = engine.validate(makeCtx({ jumps: [], elapsedMs: 500 }));
      assert.deepEqual(result, { valid: false, score: 0, reward: 0, reason: 'implausible_time' });
    });

    it('allows the exact boundary where score * tickMs === elapsedMs', () => {
      const engine = new EndlessRunnerEngine({
        courseBuilder: () => fixedCourse,
        courseLength: fixedCourse.length,
        tickMs: 100,
      });
      // score will be 10; 10 * 100 = 1000 === elapsedMs -> allowed.
      const result = engine.validate(makeCtx({ jumps: [], elapsedMs: 1000 }));
      assert.equal(result.valid, true);
      assert.equal(result.score, 10);
      assert.equal(result.reason, 'completed');
    });
  });

  describe('validate() — malformed input', () => {
    const fixedCourse = [false, true, false, true, false];
    const engine = new EndlessRunnerEngine({
      courseBuilder: () => fixedCourse,
      courseLength: fixedCourse.length,
      tickMs: 100,
    });

    it('rejects a non-array jumps field', () => {
      const result = engine.validate(makeCtx({ jumps: 'not-an-array', elapsedMs: 1_000_000 }));
      assert.deepEqual(result, { valid: false, score: 0, reward: 0, reason: 'malformed_input' });
    });

    it('rejects jumps longer than the course length', () => {
      const tooMany = new Array(fixedCourse.length + 1).fill(0);
      const result = engine.validate(makeCtx({ jumps: tooMany, elapsedMs: 1_000_000 }));
      assert.equal(result.valid, false);
      assert.equal(result.reason, 'malformed_input');
    });

    it('rejects an out-of-range jump index (>= courseLength)', () => {
      const result = engine.validate(makeCtx({ jumps: [fixedCourse.length], elapsedMs: 1_000_000 }));
      assert.equal(result.valid, false);
      assert.equal(result.reason, 'malformed_input');
    });

    it('rejects a negative jump index', () => {
      const result = engine.validate(makeCtx({ jumps: [-1], elapsedMs: 1_000_000 }));
      assert.equal(result.valid, false);
      assert.equal(result.reason, 'malformed_input');
    });

    it('rejects a non-integer jump element', () => {
      const result = engine.validate(makeCtx({ jumps: [1.5], elapsedMs: 1_000_000 }));
      assert.equal(result.valid, false);
      assert.equal(result.reason, 'malformed_input');
    });

    it('rejects a missing jumps field entirely', () => {
      const result = engine.validate(makeCtx({ jumps: undefined, elapsedMs: 1_000_000 }));
      assert.equal(result.valid, false);
      assert.equal(result.reason, 'malformed_input');
    });
  });

  describe('reward math', () => {
    it('computes reward as floor(score / 4)', () => {
      const fixedCourse = new Array(9).fill(false); // completes at score 9
      const engine = new EndlessRunnerEngine({
        courseBuilder: () => fixedCourse,
        courseLength: fixedCourse.length,
        tickMs: 100,
      });
      const result = engine.validate(makeCtx({ jumps: [], elapsedMs: 1_000_000 }));
      assert.equal(result.score, 9);
      assert.equal(result.reward, 2); // floor(9/4) = 2
    });
  });
});
