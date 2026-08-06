'use strict';

const { BaseSkillGame } = require('../BaseSkillGame');
const { seededInt } = require('../seed');

/**
 * Anagram Word Connect (Part B skill game). `start` derives a PUBLIC letter
 * rack from the hidden seed (the letters themselves are not secret — the
 * challenge is finding real words, not guessing the rack). The client forms
 * words locally and submits them once; `validate` re-derives the same rack
 * from the hidden seed and authoritatively re-checks every word:
 *   1. it is a real dictionary word,
 *   2. it is spellable from the rack's letter multiset, and
 *   3. the whole submission is time-plausible for the number of words found.
 *
 * The score is therefore provably backed by real, rack-buildable words, not a
 * self-reported number. Pure: no DB/IO/Date.now/Math.random. Never mutates
 * inputs (rack, dictionary, submission are all treated as read-only; new
 * objects/arrays are returned).
 */

/** Number of letters in the public rack. */
const LETTER_COUNT = 7;

/** Minimum vowels the derived rack must contain (keeps racks playable). */
const MIN_VOWELS = 2;

/** Shortest word the dictionary/scoring will accept. */
const MIN_WORD_LENGTH = 3;

/** Most words a single submission may contain (structural anti-cheat cap). */
const MAX_WORDS = 30;

/** Minimum milliseconds a player must spend per counted word (anti-cheat floor). */
const MIN_MS_PER_WORD = 800;

/** Score points required per 1 reward point. */
const SCORE_PER_REWARD_POINT = 5;

/** Vowel alphabet used for the rack-vowel guarantee. */
const VOWELS = 'aeiou';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';

/** A reasonable out-of-the-box dictionary of common English words (length >= 3). */
const DEFAULT_DICTIONARY = new Set([
  'cat', 'cats', 'dog', 'dogs', 'act', 'acts', 'car', 'cars', 'art', 'arts',
  'ant', 'ants', 'ate', 'eat', 'eats', 'tea', 'teas', 'sea', 'seas', 'seat',
  'seats', 'rat', 'rats', 'tar', 'tars', 'star', 'stars', 'rate', 'rates',
  'tare', 'tares', 'sat', 'sate', 'east', 'oat', 'oats', 'toe', 'toes',
  'note', 'tone', 'tones', 'stone', 'stones', 'one', 'ones', 'nose', 'store',
  'rose', 'sore', 'rope', 'ropes', 'pore', 'pores', 'earn', 'earns', 'learn',
  'learns', 'near', 'nears', 'ear', 'ears', 'era', 'eras', 'tear', 'tears',
  'late', 'later', 'alert', 'alerts', 'plate', 'plates', 'pearl', 'pearls',
]);

/**
 * Deterministically produce a rotated view of `seedHex` starting at an
 * offset that varies with `index`, always at least 13 hex chars long (the
 * amount `seededInt` consumes). Padding (via repetition) guards short seeds
 * so this stays safe even outside the normal 64-char sha256-hex hidden seed.
 * @param {string} seedHex
 * @param {number} index
 * @returns {string}
 */
function rotatedSlice(seedHex, index) {
  const padded = seedHex.length >= 13 ? seedHex : seedHex.repeat(Math.ceil(13 / seedHex.length));
  const offset = (index * 4) % padded.length;
  return padded.slice(offset) + padded.slice(0, offset);
}

/**
 * Derive a deterministic, reproducible public letter rack from the hidden
 * seed. Guarantees at least MIN_VOWELS vowels among LETTER_COUNT lowercase
 * letters so every rack is playable.
 * @param {string} hiddenSeed
 * @returns {string[]}
 */
function deriveLetters(hiddenSeed) {
  const letters = [];
  for (let i = 0; i < LETTER_COUNT; i += 1) {
    const idx = seededInt(rotatedSlice(hiddenSeed, i), ALPHABET.length);
    letters.push(ALPHABET[idx]);
  }

  let vowelCount = letters.filter((letter) => VOWELS.includes(letter)).length;
  for (let i = 0; i < LETTER_COUNT && vowelCount < MIN_VOWELS; i += 1) {
    if (!VOWELS.includes(letters[i])) {
      const vowelIdx = seededInt(rotatedSlice(hiddenSeed, LETTER_COUNT + i), VOWELS.length);
      letters[i] = VOWELS[vowelIdx];
      vowelCount += 1;
    }
  }

  return letters;
}

/** Build a letter -> count multiset Map from a rack array (read-only source). */
function buildRackCounts(letters) {
  const counts = new Map();
  for (const letter of letters) {
    counts.set(letter, (counts.get(letter) || 0) + 1);
  }
  return counts;
}

/** Whether `word` is spellable from `rackCounts` without exceeding availability. */
function isBuildableFromRack(word, rackCounts) {
  const needed = new Map();
  for (const ch of word) {
    needed.set(ch, (needed.get(ch) || 0) + 1);
  }
  for (const [ch, count] of needed) {
    if ((rackCounts.get(ch) || 0) < count) return false;
  }
  return true;
}

const ALL_LOWERCASE_LETTERS = /^[a-z]+$/;

class AnagramEngine extends BaseSkillGame {
  /**
   * @param {object} [opts]
   * @param {Set<string>} [opts.dictionary] Injectable dictionary of lowercase words.
   * @param {(hiddenSeed:string)=>string[]} [opts.letterBuilder] Injectable rack builder.
   */
  constructor({ dictionary = DEFAULT_DICTIONARY, letterBuilder = deriveLetters } = {}) {
    super();
    this._dictionary = dictionary;
    this._letterBuilder = letterBuilder;
  }

  get gameKey() {
    return 'anagram';
  }

  start(ctx) {
    const letters = this._letterBuilder(ctx.hiddenSeed);
    // Defensive copy: letterBuilder is caller-injectable and not guaranteed to
    // hand back a fresh array each call, so we never leak a shared reference.
    return { letters: [...letters], minWordLength: MIN_WORD_LENGTH };
  }

  validate(ctx) {
    const { hiddenSeed, submission, elapsedMs } = ctx;
    const words = submission && submission.words;

    if (
      !Array.isArray(words) ||
      words.length > MAX_WORDS ||
      words.some((word) => typeof word !== 'string')
    ) {
      return { valid: false, score: 0, reward: 0, reason: 'malformed_input' };
    }

    const rackCounts = buildRackCounts(this._letterBuilder(hiddenSeed));
    const uniqueWords = [...new Set(words)];

    const countingWords = uniqueWords.filter(
      (word) =>
        ALL_LOWERCASE_LETTERS.test(word) &&
        word.length >= MIN_WORD_LENGTH &&
        this._dictionary.has(word) &&
        isBuildableFromRack(word, rackCounts),
    );

    const score = countingWords.reduce((sum, word) => sum + word.length, 0);
    const n = countingWords.length;

    if (n * MIN_MS_PER_WORD > elapsedMs) {
      return { valid: false, score: 0, reward: 0, reason: 'implausible_time' };
    }

    return {
      valid: true,
      score,
      reward: Math.floor(score / SCORE_PER_REWARD_POINT),
      reason: n > 0 ? 'accepted' : 'no_valid_words',
    };
  }
}

module.exports = AnagramEngine;
module.exports.DEFAULT_DICTIONARY = DEFAULT_DICTIONARY;
module.exports.deriveLetters = deriveLetters;
module.exports.LETTER_COUNT = LETTER_COUNT;
module.exports.MIN_VOWELS = MIN_VOWELS;
module.exports.MIN_WORD_LENGTH = MIN_WORD_LENGTH;
module.exports.MAX_WORDS = MAX_WORDS;
module.exports.MIN_MS_PER_WORD = MIN_MS_PER_WORD;
module.exports.SCORE_PER_REWARD_POINT = SCORE_PER_REWARD_POINT;
module.exports.VOWELS = VOWELS;
