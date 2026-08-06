'use strict';

const config = require('../config');
const pool = require('../db/pool');
const { SkillRepository } = require('./skillRepository');
const { SkillService } = require('./skillService');
const { registerSkillGame } = require('./registry');
const AnagramEngine = require('./games/anagram');
const EndlessRunnerEngine = require('./games/endlessRunner');

/**
 * Central skill-game wiring. Register each Part B engine here; add a game by
 * dropping a file in src/skill/games/ and adding one registerSkillGame line.
 */
registerSkillGame(new AnagramEngine());
registerSkillGame(new EndlessRunnerEngine());

const repository = new SkillRepository(pool);
const skillService = new SkillService({ pool, repository, config: config.skill });

module.exports = { skillService };
