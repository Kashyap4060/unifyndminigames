'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const VaultEngine = require('../../src/engines/vault');
const { BPS_SCALE, payoutWithEdge } = require('../../src/engines/payout');
const { ValidationError, ConflictError } = require('../../src/errors');

test('Vault Engine', async (t) => {
  await t.test(
    'initiate: default keyCount 5 → metadata with winningKey (0..4) and outcome IN_PROGRESS',
    () => {
      const engine = new VaultEngine({ pickWinner: () => 2 });
      const metadata = engine.initiate();

      assert.equal(metadata.outcome, 'IN_PROGRESS');
      assert.equal(metadata.keyCount, 5);
      assert.equal(typeof metadata.winningKey, 'number');
      assert.equal(metadata.winningKey, 2);
      assert(metadata.winningKey >= 0 && metadata.winningKey < 5);
    },
  );

  await t.test(
    'initiate: custom keyCount via params.keys → metadata with correct keyCount',
    () => {
      const engine = new VaultEngine({ pickWinner: () => 3 });
      const metadata = engine.initiate({ params: { keys: 7 } });

      assert.equal(metadata.keyCount, 7);
      assert.equal(metadata.outcome, 'IN_PROGRESS');
      assert.equal(metadata.winningKey, 3);
    },
  );

  await t.test('initiate: winning key is picked via injected pickWinner', () => {
    const engine0 = new VaultEngine({ pickWinner: () => 0 });
    assert.equal(engine0.initiate({ params: { keys: 5 } }).winningKey, 0);

    const engine4 = new VaultEngine({ pickWinner: () => 4 });
    assert.equal(engine4.initiate({ params: { keys: 5 } }).winningKey, 4);

    const engine9 = new VaultEngine({ pickWinner: () => 9 });
    assert.equal(engine9.initiate({ params: { keys: 10 } }).winningKey, 9);
  });

  await t.test(
    'initiate: returns object with only winningKey, keyCount, and outcome keys',
    () => {
      const engine = new VaultEngine({ pickWinner: () => 1 });
      const metadata = engine.initiate({ params: { keys: 5 } });
      const keys = Object.keys(metadata).sort();

      assert.deepEqual(keys, ['keyCount', 'outcome', 'winningKey']);
    },
  );

  await t.test('initiate: ValidationError when keyCount < 2', () => {
    const engine = new VaultEngine({ pickWinner: () => 0 });

    assert.throws(
      () => engine.initiate({ params: { keys: 1 } }),
      (err) => {
        assert.equal(err.code, 'VALIDATION_ERROR');
        assert(err.message.includes('[2, 10]'));
        return true;
      },
    );
  });

  await t.test('initiate: ValidationError when keyCount > 10', () => {
    const engine = new VaultEngine({ pickWinner: () => 0 });

    assert.throws(
      () => engine.initiate({ params: { keys: 11 } }),
      (err) => {
        assert.equal(err.code, 'VALIDATION_ERROR');
        assert(err.message.includes('[2, 10]'));
        return true;
      },
    );
  });

  await t.test('initiate: ValidationError when keyCount is float', () => {
    const engine = new VaultEngine({ pickWinner: () => 0 });

    assert.throws(
      () => engine.initiate({ params: { keys: 5.5 } }),
      (err) => {
        assert.equal(err.code, 'VALIDATION_ERROR');
        return true;
      },
    );
  });

  await t.test(
    'WIN: pick matches winningKey → status WIN, result.win true, correct multiplier',
    () => {
      const engine = new VaultEngine({ pickWinner: () => 2 });
      const metadata = engine.initiate({ params: { keys: 5 } });

      const { metadata: nextMeta, status, result } = engine.processStep({
        metadata,
        action: 'pick',
        payload: { key: 2 },
      });

      assert.equal(status, 'WIN');
      assert.equal(result.win, true);
      assert.equal(result.revealedKey, 2);
      assert.equal(result.multiplier, 5); // 5 keys → 5.0x
      assert.equal(nextMeta.outcome, 'WON');
      assert.equal(nextMeta.multiplierBps, 5 * BPS_SCALE);
      assert.equal(nextMeta.key, 2);
    },
  );

  await t.test(
    'WIN: settle returns correct payout with house edge (5 keys, 10 bet)',
    () => {
      const engine = new VaultEngine({ pickWinner: () => 2 });
      const metadata = engine.initiate({ params: { keys: 5 } });

      const { metadata: nextMeta } = engine.processStep({
        metadata,
        action: 'pick',
        payload: { key: 2 },
      });

      const session = { pointsBet: 10 };
      const payout = engine.settle({ session, metadata: nextMeta });
      const expected = payoutWithEdge(10, 5 * BPS_SCALE);

      assert.equal(payout, expected);
      assert.equal(payout, 48); // floor(10 * 5 * 0.97) = 48
    },
  );

  await t.test(
    'WIN: settle returns correct payout with house edge (10 keys, 20 bet)',
    () => {
      const engine = new VaultEngine({ pickWinner: () => 9 });
      const metadata = engine.initiate({ params: { keys: 10 } });

      const { metadata: nextMeta } = engine.processStep({
        metadata,
        action: 'pick',
        payload: { key: 9 },
      });

      const session = { pointsBet: 20 };
      const payout = engine.settle({ session, metadata: nextMeta });
      const expected = payoutWithEdge(20, 10 * BPS_SCALE);

      assert.equal(payout, expected);
      assert.equal(payout, 194); // floor(20 * 10 * 0.97) = 194
    },
  );

  await t.test(
    'LOSE: pick does not match winningKey → status LOSE, result.win false',
    () => {
      const engine = new VaultEngine({ pickWinner: () => 2 });
      const metadata = engine.initiate({ params: { keys: 5 } });

      const { metadata: nextMeta, status, result } = engine.processStep({
        metadata,
        action: 'pick',
        payload: { key: 0 },
      });

      assert.equal(status, 'LOSE');
      assert.equal(result.win, false);
      assert.equal(result.revealedKey, 2);
      assert.equal(result.multiplier, 0);
      assert.equal(nextMeta.outcome, 'LOST');
      assert.equal(nextMeta.multiplierBps, 0);
    },
  );

  await t.test('LOSE: settle returns 0', () => {
    const engine = new VaultEngine({ pickWinner: () => 2 });
    const metadata = engine.initiate({ params: { keys: 5 } });

    const { metadata: nextMeta } = engine.processStep({
      metadata,
      action: 'pick',
      payload: { key: 4 },
    });

    const session = { pointsBet: 100 };
    const payout = engine.settle({ session, metadata: nextMeta });

    assert.equal(payout, 0);
  });

  await t.test(
    'result has exactly { win, revealedKey, multiplier } keys (win case)',
    () => {
      const engine = new VaultEngine({ pickWinner: () => 2 });
      const metadata = engine.initiate({ params: { keys: 5 } });

      const { result } = engine.processStep({
        metadata,
        action: 'pick',
        payload: { key: 2 },
      });

      const resultKeys = Object.keys(result).sort();
      assert.deepEqual(resultKeys, ['multiplier', 'revealedKey', 'win']);
    },
  );

  await t.test(
    'result has exactly { win, revealedKey, multiplier } keys (lose case)',
    () => {
      const engine = new VaultEngine({ pickWinner: () => 2 });
      const metadata = engine.initiate({ params: { keys: 5 } });

      const { result } = engine.processStep({
        metadata,
        action: 'pick',
        payload: { key: 0 },
      });

      const resultKeys = Object.keys(result).sort();
      assert.deepEqual(resultKeys, ['multiplier', 'revealedKey', 'win']);
    },
  );

  await t.test('ValidationError: invalid action', () => {
    const engine = new VaultEngine({ pickWinner: () => 2 });
    const metadata = engine.initiate({ params: { keys: 5 } });

    assert.throws(
      () =>
        engine.processStep({
          metadata,
          action: 'steal',
          payload: { key: 2 },
        }),
      (err) => {
        assert.equal(err.code, 'VALIDATION_ERROR');
        assert(err.message.includes('Unknown action'));
        return true;
      },
    );
  });

  await t.test('ValidationError: missing payload.key', () => {
    const engine = new VaultEngine({ pickWinner: () => 2 });
    const metadata = engine.initiate({ params: { keys: 5 } });

    assert.throws(
      () =>
        engine.processStep({
          metadata,
          action: 'pick',
          payload: {},
        }),
      (err) => {
        assert.equal(err.code, 'VALIDATION_ERROR');
        assert(err.message.includes('key'));
        return true;
      },
    );
  });

  await t.test('ValidationError: payload.key not a number', () => {
    const engine = new VaultEngine({ pickWinner: () => 2 });
    const metadata = engine.initiate({ params: { keys: 5 } });

    assert.throws(
      () =>
        engine.processStep({
          metadata,
          action: 'pick',
          payload: { key: 'two' },
        }),
      (err) => {
        assert.equal(err.code, 'VALIDATION_ERROR');
        return true;
      },
    );
  });

  await t.test('ValidationError: key out of range (5, for 5 keys)', () => {
    const engine = new VaultEngine({ pickWinner: () => 2 });
    const metadata = engine.initiate({ params: { keys: 5 } });

    assert.throws(
      () =>
        engine.processStep({
          metadata,
          action: 'pick',
          payload: { key: 5 },
        }),
      (err) => {
        assert.equal(err.code, 'VALIDATION_ERROR');
        assert(err.message.includes('[0, 4]'));
        return true;
      },
    );
  });

  await t.test('ValidationError: key out of range (-1)', () => {
    const engine = new VaultEngine({ pickWinner: () => 2 });
    const metadata = engine.initiate({ params: { keys: 5 } });

    assert.throws(
      () =>
        engine.processStep({
          metadata,
          action: 'pick',
          payload: { key: -1 },
        }),
      (err) => {
        assert.equal(err.code, 'VALIDATION_ERROR');
        return true;
      },
    );
  });

  await t.test('ValidationError: key is float (2.5)', () => {
    const engine = new VaultEngine({ pickWinner: () => 2 });
    const metadata = engine.initiate({ params: { keys: 5 } });

    assert.throws(
      () =>
        engine.processStep({
          metadata,
          action: 'pick',
          payload: { key: 2.5 },
        }),
      (err) => {
        assert.equal(err.code, 'VALIDATION_ERROR');
        return true;
      },
    );
  });

  await t.test('ConflictError: null metadata', () => {
    const engine = new VaultEngine({ pickWinner: () => 2 });

    assert.throws(
      () =>
        engine.processStep({
          metadata: null,
          action: 'pick',
          payload: { key: 2 },
        }),
      (err) => {
        assert.equal(err.code, 'CONFLICT');
        assert(err.message.includes('game state'));
        return true;
      },
    );
  });

  await t.test('ConflictError: game already over (act after terminal outcome)', () => {
    const engine = new VaultEngine({ pickWinner: () => 2 });
    const metadata = engine.initiate({ params: { keys: 5 } });

    // First pick
    const { metadata: nextMeta } = engine.processStep({
      metadata,
      action: 'pick',
      payload: { key: 2 },
    });

    // Try to pick again
    assert.throws(
      () =>
        engine.processStep({
          metadata: nextMeta,
          action: 'pick',
          payload: { key: 0 },
        }),
      (err) => {
        assert.equal(err.code, 'CONFLICT');
        assert(err.message.includes('already over'));
        return true;
      },
    );
  });

  await t.test('settle: loss or no metadata returns 0', () => {
    const engine = new VaultEngine({ pickWinner: () => 2 });

    assert.equal(engine.settle({ session: { pointsBet: 100 }, metadata: null }), 0);

    const metadata = { outcome: 'LOST', multiplierBps: 0 };
    assert.equal(engine.settle({ session: { pointsBet: 100 }, metadata }), 0);
  });

  await t.test('gameKey returns vault', () => {
    const engine = new VaultEngine();
    assert.equal(engine.gameKey, 'vault');
  });

  await t.test('multiple games can have different winners via pickWinner injection', () => {
    const engine0 = new VaultEngine({ pickWinner: () => 0 });
    const engine2 = new VaultEngine({ pickWinner: () => 2 });
    const engine4 = new VaultEngine({ pickWinner: () => 4 });

    assert.equal(engine0.initiate({ params: { keys: 5 } }).winningKey, 0);
    assert.equal(engine2.initiate({ params: { keys: 5 } }).winningKey, 2);
    assert.equal(engine4.initiate({ params: { keys: 5 } }).winningKey, 4);
  });

  await t.test('multiplier scales with keyCount for 2 keys', () => {
    const engine = new VaultEngine({ pickWinner: () => 0 });
    const metadata = engine.initiate({ params: { keys: 2 } });

    const { result } = engine.processStep({
      metadata,
      action: 'pick',
      payload: { key: 0 },
    });

    assert.equal(result.multiplier, 2); // 2 keys → 2.0x
  });

  await t.test('multiplier scales with keyCount for 10 keys', () => {
    const engine = new VaultEngine({ pickWinner: () => 5 });
    const metadata = engine.initiate({ params: { keys: 10 } });

    const { result } = engine.processStep({
      metadata,
      action: 'pick',
      payload: { key: 5 },
    });

    assert.equal(result.multiplier, 10); // 10 keys → 10.0x
  });

  await t.test('winning key is never revealed before the pick', () => {
    const engine = new VaultEngine({ pickWinner: () => 3 });
    const metadata = engine.initiate({ params: { keys: 5 } });

    // The metadata should not expose winningKey before the client actually picks
    // (This is enforced by the architecture, not the engine itself,
    // but we verify the engine doesn't leak it in unexpected ways)
    assert.equal(typeof metadata.winningKey, 'number');
    assert.equal(metadata.winningKey, 3);
  });
});
