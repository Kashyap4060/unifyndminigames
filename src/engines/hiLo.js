'use strict';

const { randomInt } = require('crypto');
const { BaseGameEngine } = require('./BaseGameEngine');
const { ValidationError, ConflictError } = require('../errors');
const { BPS_SCALE, payoutWithEdge } = require('./payout');

// A standard deck (ignoring suits) has 13 distinct ranks: 2..14 (Ace high).
const RANKS = 13;
const MIN_RANK_VALUE = 2;
const MAX_RANK_VALUE = 14;
const COPIES_PER_RANK = 4; // four suits per rank in a 52-card deck

const DIRECTION_HIGHER = 'higher';
const DIRECTION_LOWER = 'lower';

/**
 * Build an unshuffled 52-card deck of rank values (2..14), four of each rank.
 * @returns {number[]}
 */
function buildDeck() {
  const deck = [];
  for (let rank = MIN_RANK_VALUE; rank <= MAX_RANK_VALUE; rank += 1) {
    for (let copy = 0; copy < COPIES_PER_RANK; copy += 1) {
      deck.push(rank);
    }
  }
  return deck;
}

/**
 * Fisher-Yates shuffle using crypto RNG so the card order is unpredictable.
 * Returns a NEW array; does not mutate the input.
 * @param {number[]} array
 * @returns {number[]}
 */
function secureShuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Hi-Lo engine. Multi-step higher/lower streak game played against a single
 * shuffled 52-card deck (suits ignored — only rank values 2..14 matter).
 * Each correct guess grows a stored multiplier at fair odds (naive rank
 * counting relative to the current card); cashing out (or a wrong/forced
 * guess) settles the session. The full deck is server-side only and never
 * returned to clients.
 */
class HiLoEngine extends BaseGameEngine {
  /**
   * @param {object} [opts]
   * @param {(array:number[])=>number[]} [opts.shuffle]
   *        Injectable shuffle function (defaults to the secure crypto shuffle).
   *        Tests inject a deterministic shuffle; production uses the default.
   */
  constructor({ shuffle = secureShuffle } = {}) {
    super();
    this._shuffle = shuffle;
  }

  get gameKey() {
    return 'hi_lo';
  }

  initiate() {
    const deck = this._shuffle(buildDeck());
    return {
      deck, // number[] — SERVER-ONLY, never returned to the client
      position: 1, // index of the NEXT card to draw
      currentValue: deck[0],
      multiplierBps: BPS_SCALE, // 1.0000x
      outcome: 'IN_PROGRESS', // IN_PROGRESS | LOST | CASHED_OUT
    };
  }

  processStep({ metadata, action, payload }) {
    if (!metadata) {
      throw new ConflictError('Session has no game state');
    }
    if (metadata.outcome !== 'IN_PROGRESS') {
      throw new ConflictError('Game is already over');
    }

    if (action === 'cashout') {
      const next = { ...metadata, outcome: 'CASHED_OUT' };
      return {
        metadata: next,
        status: 'WIN',
        result: {
          action: 'cashout',
          multiplier: next.multiplierBps / BPS_SCALE,
          cardsLeft: next.deck.length - next.position,
        },
      };
    }

    if (action !== 'guess') {
      throw new ValidationError(`Unknown action "${action}" for hi_lo`);
    }

    const direction = payload && payload.direction;
    if (direction !== DIRECTION_HIGHER && direction !== DIRECTION_LOWER) {
      throw new ValidationError('payload.direction must be "higher" or "lower"');
    }

    const { deck, position, currentValue, multiplierBps } = metadata;
    const next = deck[position];

    // Naive fair-odds approximation: count how many of the 13 ranks strictly
    // satisfy the chosen direction relative to the current card. This ignores
    // how many of those ranks have already been drawn from the deck — a
    // simplification that keeps the odds calculation independent of deck
    // history, at the cost of not being perfectly fair late in the deck.
    const favorable =
      direction === DIRECTION_HIGHER ? MAX_RANK_VALUE - currentValue : currentValue - MIN_RANK_VALUE;

    const correct =
      favorable > 0 &&
      ((direction === DIRECTION_HIGHER && next > currentValue) ||
        (direction === DIRECTION_LOWER && next < currentValue));

    if (!correct) {
      const lostMetadata = { ...metadata, position: position + 1, outcome: 'LOST' };
      return {
        metadata: lostMetadata,
        status: 'LOSE',
        result: {
          nextCard: next,
          correct: false,
          multiplier: multiplierBps / BPS_SCALE,
          cardsLeft: deck.length - position - 1,
        },
      };
    }

    const newMultiplierBps = Math.floor((multiplierBps * RANKS) / favorable);
    const newPosition = position + 1;
    const newCurrent = next;
    const deckExhausted = newPosition >= deck.length;
    const outcome = deckExhausted ? 'CASHED_OUT' : 'IN_PROGRESS';
    const status = deckExhausted ? 'WIN' : 'CONTINUE';

    const wonMetadata = {
      ...metadata,
      position: newPosition,
      currentValue: newCurrent,
      multiplierBps: newMultiplierBps,
      outcome,
    };

    return {
      metadata: wonMetadata,
      status,
      result: {
        nextCard: next,
        correct: true,
        multiplier: newMultiplierBps / BPS_SCALE,
        cardsLeft: deck.length - newPosition,
      },
    };
  }

  settle({ session, metadata }) {
    if (!metadata || metadata.outcome === 'LOST') {
      return 0; // wrong/tied guess or no metadata — total loss
    }
    // CASHED_OUT, or IN_PROGRESS settled directly via /settle (cash out now):
    // both are intentionally payable at the stored multiplier — only LOST
    // denies payout, so the denylist above is deliberate, not incomplete.
    return payoutWithEdge(session.pointsBet, metadata.multiplierBps);
  }
}

module.exports = HiLoEngine;
module.exports.secureShuffle = secureShuffle;
module.exports.buildDeck = buildDeck;
