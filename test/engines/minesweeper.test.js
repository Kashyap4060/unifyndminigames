'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const MinesweeperEngine = require('../../src/engines/minesweeper');
const { ValidationError, ConflictError } = require('../../src/errors');
const { BPS_SCALE, payoutWithEdge } = require('../../src/engines/payout');

/** Injects a fixed, deterministic mine layout regardless of totalTiles/mines args. */
function fixedLayout(layout) {
  return { mineBuilder: () => [...layout] };
}

test('gameKey returns minesweeper', () => {
  const engine = new MinesweeperEngine();
  assert.strictEqual(engine.gameKey, 'minesweeper');
});

test('initiate with defaults produces a 25-tile board with 3 mines', () => {
  const engine = new MinesweeperEngine();
  const metadata = engine.initiate({ params: undefined });

  assert.strictEqual(metadata.tiles.length, 25);
  assert.strictEqual(metadata.totalTiles, 25);
  assert.strictEqual(metadata.mines, 3);
  const mineCount = metadata.tiles.filter((t) => t === true).length;
  assert.strictEqual(mineCount, 3);
  assert.deepStrictEqual(metadata.revealed, []);
  assert.strictEqual(metadata.multiplierBps, BPS_SCALE);
  assert.strictEqual(metadata.outcome, 'IN_PROGRESS');
});

test('initiate with custom params produces a matching board', () => {
  const engine = new MinesweeperEngine();
  const metadata = engine.initiate({ params: { tiles: 10, mines: 4 } });

  assert.strictEqual(metadata.tiles.length, 10);
  assert.strictEqual(metadata.totalTiles, 10);
  assert.strictEqual(metadata.mines, 4);
  const mineCount = metadata.tiles.filter((t) => t === true).length;
  assert.strictEqual(mineCount, 4);
});

test('tiles below MIN_TILES throws ValidationError', () => {
  const engine = new MinesweeperEngine();
  assert.throws(
    () => engine.initiate({ params: { tiles: 1, mines: 1 } }),
    (err) => err instanceof ValidationError && err.code === 'VALIDATION_ERROR'
  );
});

test('mines = 0 throws ValidationError', () => {
  const engine = new MinesweeperEngine();
  assert.throws(
    () => engine.initiate({ params: { tiles: 5, mines: 0 } }),
    (err) => err instanceof ValidationError && err.code === 'VALIDATION_ERROR'
  );
});

test('mines = tiles throws ValidationError', () => {
  const engine = new MinesweeperEngine();
  assert.throws(
    () => engine.initiate({ params: { tiles: 5, mines: 5 } }),
    (err) => err instanceof ValidationError && err.code === 'VALIDATION_ERROR'
  );
});

test('safe reveal grows multiplier at fair odds and continues', () => {
  // 5 tiles, 1 mine at index 0.
  const engine = new MinesweeperEngine(fixedLayout([true, false, false, false, false]));
  const metadata = engine.initiate({ params: { tiles: 5, mines: 1 } });

  const { metadata: next, status, result } = engine.processStep({
    metadata,
    action: 'reveal',
    payload: { tile: 1 },
  });

  // remaining = 5, safeRemaining = 4; newMultiplierBps = floor(10000 * 5 / 4) = 12500
  assert.strictEqual(status, 'CONTINUE');
  assert.strictEqual(next.outcome, 'IN_PROGRESS');
  assert.deepStrictEqual(next.revealed, [1]);
  assert.strictEqual(next.multiplierBps, 12500);

  assert.strictEqual(result.action, 'reveal');
  assert.strictEqual(result.safe, true);
  assert.strictEqual(result.multiplier, 1.25);
  assert.strictEqual(result.revealedCount, 1);
  assert.strictEqual(result.safeTilesLeft, 3);
  assert.ok(!Object.prototype.hasOwnProperty.call(result, 'tiles'));
});

test('two safe reveals compound the multiplier (not reset per step)', () => {
  // 5 tiles, 1 mine at index 0.
  const engine = new MinesweeperEngine(fixedLayout([true, false, false, false, false]));
  const metadata = engine.initiate({ params: { tiles: 5, mines: 1 } });

  const step1 = engine.processStep({ metadata, action: 'reveal', payload: { tile: 1 } });
  assert.strictEqual(step1.metadata.multiplierBps, 12500);

  const step2 = engine.processStep({
    metadata: step1.metadata,
    action: 'reveal',
    payload: { tile: 2 },
  });

  // remaining = 4, safeRemaining = 3; newMultiplierBps = floor(12500 * 4 / 3) = 16666
  assert.strictEqual(step2.status, 'CONTINUE');
  assert.strictEqual(step2.metadata.outcome, 'IN_PROGRESS');
  assert.deepStrictEqual(step2.metadata.revealed, [1, 2]);
  assert.strictEqual(step2.metadata.multiplierBps, 16666);
  assert.strictEqual(step2.result.multiplier, 1.6666);
  assert.strictEqual(step2.result.revealedCount, 2);
  assert.strictEqual(step2.result.safeTilesLeft, 2);
});

test('hitting a mine loses and settle pays 0', () => {
  const engine = new MinesweeperEngine(fixedLayout([true, false, false, false, false]));
  const metadata = engine.initiate({ params: { tiles: 5, mines: 1 } });

  const { metadata: next, status, result } = engine.processStep({
    metadata,
    action: 'reveal',
    payload: { tile: 0 },
  });

  assert.strictEqual(status, 'LOSE');
  assert.strictEqual(next.outcome, 'DEAD');
  assert.strictEqual(result.action, 'reveal');
  assert.strictEqual(result.safe, false);
  assert.strictEqual(result.multiplier, 1);
  assert.strictEqual(result.revealedCount, 0);
  assert.ok(!Object.prototype.hasOwnProperty.call(result, 'tiles'));

  const payout = engine.settle({ session: { pointsBet: 10 }, metadata: next });
  assert.strictEqual(payout, 0);
});

test('cashout wins and settles at the current multiplier', () => {
  const engine = new MinesweeperEngine(fixedLayout([true, false, false, false, false]));
  const metadata = engine.initiate({ params: { tiles: 5, mines: 1 } });

  const step1 = engine.processStep({ metadata, action: 'reveal', payload: { tile: 1 } });
  assert.strictEqual(step1.metadata.multiplierBps, 12500);

  const { metadata: next, status, result } = engine.processStep({
    metadata: step1.metadata,
    action: 'cashout',
  });

  assert.strictEqual(status, 'WIN');
  assert.strictEqual(next.outcome, 'CASHED_OUT');
  assert.strictEqual(result.action, 'cashout');
  assert.strictEqual(result.multiplier, 1.25);
  assert.strictEqual(result.revealedCount, 1);
  assert.ok(!Object.prototype.hasOwnProperty.call(result, 'tiles'));

  const payout = engine.settle({ session: { pointsBet: 10 }, metadata: next });
  assert.strictEqual(payout, payoutWithEdge(10, 12500));
});

test('revealing all safe tiles forces a WIN (cashed out)', () => {
  // 5 tiles, 1 mine at index 0. Safe tiles: 1, 2, 3, 4.
  const engine = new MinesweeperEngine(fixedLayout([true, false, false, false, false]));
  let metadata = engine.initiate({ params: { tiles: 5, mines: 1 } });

  const safeTiles = [1, 2, 3];
  for (const tile of safeTiles) {
    const step = engine.processStep({ metadata, action: 'reveal', payload: { tile } });
    assert.strictEqual(step.status, 'CONTINUE');
    metadata = step.metadata;
  }

  const finalStep = engine.processStep({ metadata, action: 'reveal', payload: { tile: 4 } });
  assert.strictEqual(finalStep.status, 'WIN');
  assert.strictEqual(finalStep.metadata.outcome, 'CASHED_OUT');
  assert.strictEqual(finalStep.result.safe, true);
  assert.strictEqual(finalStep.result.revealedCount, 4);
  assert.strictEqual(finalStep.result.safeTilesLeft, 0);
});

test('re-revealing an already-revealed tile throws ValidationError', () => {
  const engine = new MinesweeperEngine(fixedLayout([true, false, false, false, false]));
  const metadata = engine.initiate({ params: { tiles: 5, mines: 1 } });

  const step1 = engine.processStep({ metadata, action: 'reveal', payload: { tile: 1 } });

  assert.throws(
    () => engine.processStep({ metadata: step1.metadata, action: 'reveal', payload: { tile: 1 } }),
    (err) => err instanceof ValidationError && err.code === 'VALIDATION_ERROR'
  );
});

test('invalid tile index throws ValidationError', () => {
  const engine = new MinesweeperEngine(fixedLayout([true, false, false, false, false]));
  const metadata = engine.initiate({ params: { tiles: 5, mines: 1 } });

  assert.throws(
    () => engine.processStep({ metadata, action: 'reveal', payload: { tile: 5 } }),
    (err) => err instanceof ValidationError && err.code === 'VALIDATION_ERROR'
  );
  assert.throws(
    () => engine.processStep({ metadata, action: 'reveal', payload: { tile: -1 } }),
    (err) => err instanceof ValidationError && err.code === 'VALIDATION_ERROR'
  );
  assert.throws(
    () => engine.processStep({ metadata, action: 'reveal', payload: { tile: 1.5 } }),
    (err) => err instanceof ValidationError && err.code === 'VALIDATION_ERROR'
  );
});

test('invalid action throws ValidationError', () => {
  const engine = new MinesweeperEngine(fixedLayout([true, false, false, false, false]));
  const metadata = engine.initiate({ params: { tiles: 5, mines: 1 } });

  assert.throws(
    () => engine.processStep({ metadata, action: 'dig', payload: { tile: 1 } }),
    (err) => err instanceof ValidationError && err.code === 'VALIDATION_ERROR'
  );
});

test('null metadata throws ConflictError', () => {
  const engine = new MinesweeperEngine();

  assert.throws(
    () => engine.processStep({ metadata: null, action: 'reveal', payload: { tile: 0 } }),
    (err) => err instanceof ConflictError && err.code === 'CONFLICT'
  );
});

test('acting after a terminal outcome throws ConflictError', () => {
  const engine = new MinesweeperEngine(fixedLayout([true, false, false, false, false]));
  const metadata = engine.initiate({ params: { tiles: 5, mines: 1 } });

  const { metadata: terminal } = engine.processStep({
    metadata,
    action: 'reveal',
    payload: { tile: 0 },
  });
  assert.strictEqual(terminal.outcome, 'DEAD');

  assert.throws(
    () => engine.processStep({ metadata: terminal, action: 'reveal', payload: { tile: 1 } }),
    (err) => err instanceof ConflictError && err.code === 'CONFLICT'
  );
});

test('result never contains the tiles/mine layout across all step types', () => {
  const engine = new MinesweeperEngine(fixedLayout([true, false, false, false, false]));
  const metadata = engine.initiate({ params: { tiles: 5, mines: 1 } });

  const revealStep = engine.processStep({ metadata, action: 'reveal', payload: { tile: 1 } });
  assert.ok(!('tiles' in revealStep.result));

  const cashoutStep = engine.processStep({ metadata: revealStep.metadata, action: 'cashout' });
  assert.ok(!('tiles' in cashoutStep.result));

  const mineEngine = new MinesweeperEngine(fixedLayout([true, false, false, false, false]));
  const mineMetadata = mineEngine.initiate({ params: { tiles: 5, mines: 1 } });
  const mineStep = mineEngine.processStep({ metadata: mineMetadata, action: 'reveal', payload: { tile: 0 } });
  assert.ok(!('tiles' in mineStep.result));
});
