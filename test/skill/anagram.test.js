'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const AnagramEngine = require('../../src/skill/games/anagram');
const { deriveLetters } = AnagramEngine;

const FIXED_RACK = ['c', 'a', 't', 's', 'd', 'o', 'g'];
const FIXED_DICTIONARY = new Set(['cat', 'cats', 'dog', 'dogs', 'act', 'taco', 'cab', 'tot', 'at']);

function makeEngine(overrides = {}) {
  return new AnagramEngine({
    letterBuilder: () => FIXED_RACK,
    dictionary: FIXED_DICTIONARY,
    ...overrides,
  });
}

function makeCtx({ words, elapsedMs = 60000, hiddenSeed = 'deadbeef' }) {
  return {
    game: { gameId: 1, gameKey: 'anagram', gameType: 'SKILL' },
    session: { sessionId: 'sess-1', userId: 1, gameId: 1 },
    hiddenSeed,
    submission: { words },
    elapsedMs,
  };
}

describe('AnagramEngine', () => {
  it('has the expected gameKey', () => {
    assert.equal(makeEngine().gameKey, 'anagram');
  });

  describe('start', () => {
    it('returns the public rack (from the injected builder) and minWordLength', () => {
      const engine = makeEngine();
      const result = engine.start(makeCtx({ words: [] }));
      assert.deepEqual(result, { letters: FIXED_RACK, minWordLength: 3 });
    });

    it('does not mutate the returned letters if the caller mutates the result', () => {
      const engine = makeEngine();
      const result = engine.start(makeCtx({ words: [] }));
      result.letters.push('z');
      assert.deepEqual(FIXED_RACK, ['c', 'a', 't', 's', 'd', 'o', 'g']);
    });
  });

  describe('deriveLetters (real, seed-derived rack)', () => {
    it('produces LETTER_COUNT lowercase letters with at least MIN_VOWELS vowels', () => {
      const seeds = [
        'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      ];
      for (const seed of seeds) {
        const letters = deriveLetters(seed);
        assert.equal(letters.length, 7);
        for (const letter of letters) {
          assert.match(letter, /^[a-z]$/);
        }
        const vowelCount = letters.filter((l) => 'aeiou'.includes(l)).length;
        assert.ok(vowelCount >= 2, `expected >=2 vowels, got ${vowelCount} for seed ${seed}`);
      }
    });

    it('is deterministic for the same seed', () => {
      const seed = 'abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123ab';
      assert.deepEqual(deriveLetters(seed), deriveLetters(seed));
    });
  });

  describe('validate — counting valid words', () => {
    it('counts words buildable from the rack and in the dictionary; score/reward from concrete literals', () => {
      const engine = makeEngine();
      const result = engine.validate(makeCtx({ words: ['cat', 'dog'] }));
      assert.deepEqual(result, { valid: true, score: 6, reward: 1, reason: 'accepted' });
    });

    it('sums lengths across multiple distinct counting words', () => {
      const engine = makeEngine();
      const result = engine.validate(makeCtx({ words: ['cat', 'dog', 'act'] }));
      assert.equal(result.valid, true);
      assert.equal(result.score, 9); // 3 + 3 + 3
      assert.equal(result.reward, 1); // floor(9/5)
      assert.equal(result.reason, 'accepted');
    });
  });

  describe('validate — ignore (not reject) invalid words', () => {
    it('ignores a word not in the dictionary while still counting a valid one', () => {
      const engine = makeEngine();
      // "cog" is buildable from the rack but not in FIXED_DICTIONARY.
      const result = engine.validate(makeCtx({ words: ['cog', 'cat'] }));
      assert.equal(result.valid, true);
      assert.equal(result.score, 3);
      assert.equal(result.reward, 0);
      assert.equal(result.reason, 'accepted');
    });

    it('ignores a dictionary word that needs a letter absent from the rack', () => {
      const engine = makeEngine();
      // "cab" is in the dictionary but the rack has no "b".
      const result = engine.validate(makeCtx({ words: ['cab'] }));
      assert.deepEqual(result, { valid: true, score: 0, reward: 0, reason: 'no_valid_words' });
    });

    it('ignores a dictionary word needing more copies of a letter than the rack has', () => {
      const engine = makeEngine();
      // "tot" needs two "t"s; the rack has only one.
      const result = engine.validate(makeCtx({ words: ['tot', 'cat'] }));
      assert.equal(result.valid, true);
      assert.equal(result.score, 3); // only "cat" counts
      assert.equal(result.reason, 'accepted');
    });

    it('ignores a word shorter than MIN_WORD_LENGTH even if it is in the dictionary', () => {
      const engine = makeEngine();
      // "at" is in FIXED_DICTIONARY but has length 2 < MIN_WORD_LENGTH.
      const result = engine.validate(makeCtx({ words: ['at'] }));
      assert.deepEqual(result, { valid: true, score: 0, reward: 0, reason: 'no_valid_words' });
    });

    it('counts duplicate words only once', () => {
      const engine = makeEngine();
      const result = engine.validate(makeCtx({ words: ['cat', 'cat'] }));
      assert.equal(result.valid, true);
      assert.equal(result.score, 3);
      assert.equal(result.reward, 0);
      assert.equal(result.reason, 'accepted');
    });
  });

  describe('validate — no valid words', () => {
    it('returns valid:true, score 0, reward 0, reason no_valid_words for an empty submission', () => {
      const engine = makeEngine();
      const result = engine.validate(makeCtx({ words: [] }));
      assert.deepEqual(result, { valid: true, score: 0, reward: 0, reason: 'no_valid_words' });
    });

    it('returns no_valid_words when every submitted word fails every check', () => {
      const engine = makeEngine();
      const result = engine.validate(makeCtx({ words: ['xyz', 'qqq'] }));
      assert.deepEqual(result, { valid: true, score: 0, reward: 0, reason: 'no_valid_words' });
    });
  });

  describe('validate — malformed input', () => {
    it('rejects when words is not an array', () => {
      const engine = makeEngine();
      const result = engine.validate(makeCtx({ words: 'cat' }));
      assert.deepEqual(result, { valid: false, score: 0, reward: 0, reason: 'malformed_input' });
    });

    it('rejects when an element is not a string', () => {
      const engine = makeEngine();
      const result = engine.validate(makeCtx({ words: ['cat', 123] }));
      assert.deepEqual(result, { valid: false, score: 0, reward: 0, reason: 'malformed_input' });
    });

    it('rejects when the word list exceeds MAX_WORDS', () => {
      const engine = makeEngine();
      const words = Array.from({ length: 31 }, () => 'cat');
      const result = engine.validate(makeCtx({ words }));
      assert.deepEqual(result, { valid: false, score: 0, reward: 0, reason: 'malformed_input' });
    });
  });

  describe('validate — time plausibility', () => {
    it('rejects as implausible_time when too many valid words are found too fast', () => {
      const engine = makeEngine();
      // 3 counting words * 800ms = 2400ms > 100ms elapsed -> implausible.
      const result = engine.validate(makeCtx({ words: ['cat', 'dog', 'act'], elapsedMs: 100 }));
      assert.deepEqual(result, { valid: false, score: 0, reward: 0, reason: 'implausible_time' });
    });

    it('allows the exact boundary where n * MIN_MS_PER_WORD === elapsedMs', () => {
      const engine = makeEngine();
      // 2 counting words * 800ms = 1600ms === elapsedMs -> allowed (not strictly greater).
      const result = engine.validate(makeCtx({ words: ['cat', 'dog'], elapsedMs: 1600 }));
      assert.deepEqual(result, { valid: true, score: 6, reward: 1, reason: 'accepted' });
    });
  });

  describe('validate — rack multiset correctness', () => {
    it('rejects a word needing two of a letter when the rack has only one (concrete case)', () => {
      const engine = new AnagramEngine({
        letterBuilder: () => ['t', 'o', 'x', 'y', 'z', 'q', 'w'],
        dictionary: new Set(['tot', 'too']),
      });
      // "tot" needs t:2, o:1; rack has t:1, o:1 -> fails on t count.
      const result = engine.validate(makeCtx({ words: ['tot'] }));
      assert.deepEqual(result, { valid: true, score: 0, reward: 0, reason: 'no_valid_words' });
    });

    it('accepts a word needing exactly the letters available (no more, no less)', () => {
      const engine = new AnagramEngine({
        letterBuilder: () => ['t', 'o', 'x', 'y', 'z', 'q', 'w'],
        dictionary: new Set(['too']),
      });
      // "too" needs t:1, o:2; rack has t:1, o:1 -> still fails (only one "o").
      const result = engine.validate(makeCtx({ words: ['too'] }));
      assert.deepEqual(result, { valid: true, score: 0, reward: 0, reason: 'no_valid_words' });
    });
  });

  it('never mutates the submission object', () => {
    const engine = makeEngine();
    const ctx = makeCtx({ words: ['cat', 'cat', 'dog'] });
    const wordsBefore = [...ctx.submission.words];
    engine.validate(ctx);
    assert.deepEqual(ctx.submission.words, wordsBefore);
  });
});
