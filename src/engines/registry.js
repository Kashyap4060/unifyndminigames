'use strict';

const { ConflictError } = require('../errors');
const { BaseGameEngine } = require('./BaseGameEngine');

/**
 * The Game Router: maps games_directory.game_key -> engine instance. This is the
 * single extension point — register an engine to add a game, with no core edits.
 */
const engines = new Map(); // game_key -> BaseGameEngine
let defaultEngine = null; // optional catch-all (used by tests; avoid in prod)

function registerEngine(engine) {
  if (!(engine instanceof BaseGameEngine)) {
    throw new TypeError('engine must extend BaseGameEngine');
  }
  const key = engine.gameKey; // throws if the subclass didn't override it
  engines.set(key, engine);
}

/** Optional fallback engine when no game-specific one is registered. */
function setDefaultEngine(engine) {
  if (engine !== null && !(engine instanceof BaseGameEngine)) {
    throw new TypeError('engine must extend BaseGameEngine or be null');
  }
  defaultEngine = engine;
}

/** Test/utility helper: wipe all registrations. */
function clearEngines() {
  engines.clear();
  defaultEngine = null;
}

/**
 * @param {string} gameKey
 * @returns {BaseGameEngine}
 */
function getEngine(gameKey) {
  const engine = engines.get(gameKey) || defaultEngine;
  if (!engine) {
    // Fail closed: refuse to run a game with no registered engine rather than
    // guessing behavior. Log the specific key server-side; keep client generic.
    // eslint-disable-next-line no-console
    console.error(`No game engine registered for game "${gameKey}"`);
    throw new ConflictError('Game is temporarily unavailable');
  }
  return engine;
}

module.exports = { registerEngine, setDefaultEngine, clearEngines, getEngine };
