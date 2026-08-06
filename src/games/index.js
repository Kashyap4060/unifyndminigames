'use strict';

/**
 * Central game registration. Requiring this module (done once at startup in
 * src/app.js) registers every game engine with the router.
 *
 * To add one of the other 29 games later:
 *   1. Create src/engines/<yourGame>.js extending BaseGameEngine.
 *   2. Add two lines below: require it and registerEngine(new YourEngine()).
 * No core files (services, routes, schema) need to change.
 */

const { registerEngine } = require('../engines/registry');
const RussianRouletteEngine = require('../engines/russianRoulette');
const CoinFlipEngine = require('../engines/coinFlip');
const DiceTowerEngine = require('../engines/diceTower');
const ShellGameEngine = require('../engines/shellGame');
const HiLoEngine = require('../engines/hiLo');
const CrashEngine = require('../engines/crash');

registerEngine(new RussianRouletteEngine());
registerEngine(new CoinFlipEngine());
registerEngine(new DiceTowerEngine());
registerEngine(new ShellGameEngine());
registerEngine(new HiLoEngine());
registerEngine(new CrashEngine());

// registerEngine(new BlackjackEngine());
// registerEngine(new SpinWheelEngine());
// ...

module.exports = {};
