'use strict';

const { ConflictError } = require('../errors');
const { BaseSkillGame } = require('./BaseSkillGame');

/** Registry mapping games_directory.game_key -> skill game engine. */
const games = new Map();
let defaultGame = null; // optional catch-all (tests only)

function registerSkillGame(game) {
  if (!(game instanceof BaseSkillGame)) {
    throw new TypeError('game must extend BaseSkillGame');
  }
  games.set(game.gameKey, game);
}

function setDefaultSkillGame(game) {
  if (game !== null && !(game instanceof BaseSkillGame)) {
    throw new TypeError('game must extend BaseSkillGame or be null');
  }
  defaultGame = game;
}

function clearSkillGames() {
  games.clear();
  defaultGame = null;
}

function getSkillGame(gameKey) {
  const game = games.get(gameKey) || defaultGame;
  if (!game) {
    // eslint-disable-next-line no-console
    console.error(`No skill game registered for game "${gameKey}"`);
    throw new ConflictError('Game is temporarily unavailable');
  }
  return game;
}

module.exports = { registerSkillGame, setDefaultSkillGame, clearSkillGames, getSkillGame };
