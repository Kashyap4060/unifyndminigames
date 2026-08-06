'use strict';

/**
 * Integration tests for the transactional bet endpoint against a REAL MySQL 8
 * (row locks and transactions cannot be mocked). A throwaway Docker container
 * is started once for the whole file, schema-loaded, and torn down at the end.
 *
 * Run with: npm test   (requires Docker)
 *
 * Tests exercise the service layer directly (initiateGameSession) so the focus
 * stays on transactional integrity, not HTTP/JWT plumbing (covered elsewhere).
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { startMysql, stopMysql } = require('./helpers/docker-mysql');
const {
  makePool,
  resetData,
  seedUser,
  seedGame,
  getBalance,
  sumBetDebits,
  countSessions,
  countBetLedgerRows,
  countPayoutLedgerRows,
  getSession,
  getSessionMetadata,
} = require('./helpers/db');

// Populated in before() once env points at the container.
let initiateGameSession;
let settleGameSession;
let processGameStep;
let setDefaultEngine;
let registerEngine;
let RussianRouletteEngine;
let TestEngineClass;
let servicePool;
let testPool;

// A fresh default test engine: settle pays 2x the bet on a "win", else 0.
function newTestEngine() {
  return new TestEngineClass();
}

before(async () => {
  await startMysql();
  // Require AFTER env is set so config/pool bind to the test container.
  ({ initiateGameSession } = require('../src/services/gameSessionService'));
  ({ settleGameSession } = require('../src/services/gameSettlementService'));
  ({ processGameStep } = require('../src/services/gameProcessService'));
  servicePool = require('../src/db/pool');
  testPool = makePool();

  const registry = require('../src/engines/registry');
  ({ setDefaultEngine, registerEngine } = registry);
  RussianRouletteEngine = require('../src/engines/russianRoulette');
  const { BaseGameEngine } = require('../src/engines/BaseGameEngine');

  // A catch-all TEST engine for the generic test-game keys used by the money
  // tests. In tests we own the engine, so keying settle off `result` to drive
  // win/loss scenarios is fine — production engines derive payout from trusted
  // server state, never from client input.
  TestEngineClass = class TestEngine extends BaseGameEngine {
    get gameKey() {
      return '__test__';
    }

    initiate() {
      return {};
    }

    processStep({ metadata }) {
      return { metadata: metadata || {}, status: 'CONTINUE', result: {} };
    }

    settle({ session, result }) {
      return result && result.win ? Number(session.pointsBet) * 2 : 0;
    }
  };
  setDefaultEngine(new TestEngineClass());
}, { timeout: 180_000 });

after(async () => {
  if (testPool) await testPool.end();
  if (servicePool) await servicePool.end();
  stopMysql();
});

beforeEach(async () => {
  await resetData(testPool);
});

describe('concurrency — balance can never be overdrawn', () => {
  it('lets exactly floor(balance/bet) parallel bets succeed and no more', async () => {
    const userId = await seedUser(testPool, 100);
    const gameId = await seedGame(testPool, { minBet: 1, maxBet: 50 });
    const CONCURRENT = 20;
    const BET = 10; // 100 / 10 => exactly 10 can win

    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENT }, () =>
        initiateGameSession({ userId, gameId, pointsBet: BET }),
      ),
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');

    assert.equal(succeeded.length, 10, 'exactly 10 bets should succeed');
    assert.equal(failed.length, 10, 'the other 10 should fail');
    for (const r of failed) {
      assert.equal(r.reason.code, 'INSUFFICIENT_FUNDS', 'losers fail cleanly, not with a crash');
    }

    // The invariant: no overdraft, and the ledger reconciles to the balance.
    assert.equal(await getBalance(testPool, userId), '0', 'balance must not go negative');
    assert.equal(await sumBetDebits(testPool, userId), 100, 'debits sum to the starting balance');
    assert.equal(await countSessions(testPool, userId), 10, 'one session per winning bet');
    assert.equal(await countBetLedgerRows(testPool, userId), 10, 'one ledger row per winning bet');
  });

  it('produces no partial state when a bet is rejected for insufficient funds', async () => {
    const userId = await seedUser(testPool, 5);
    const gameId = await seedGame(testPool, { minBet: 1, maxBet: 50 });

    await assert.rejects(
      () => initiateGameSession({ userId, gameId, pointsBet: 10 }),
      (err) => err.code === 'INSUFFICIENT_FUNDS',
    );

    assert.equal(await getBalance(testPool, userId), '5', 'balance unchanged on rejection');
    assert.equal(await countSessions(testPool, userId), 0, 'no session created');
    assert.equal(await countBetLedgerRows(testPool, userId), 0, 'no ledger row written');
  });
});

describe('idempotency — a key never double-charges', () => {
  it('replays the same session on a sequential retry with the same key', async () => {
    const userId = await seedUser(testPool, 100);
    const gameId = await seedGame(testPool, { minBet: 1, maxBet: 50 });
    const key = 'idem-key-abc';

    const first = await initiateGameSession({ userId, gameId, pointsBet: 10, idempotencyKey: key });
    const second = await initiateGameSession({ userId, gameId, pointsBet: 10, idempotencyKey: key });

    assert.equal(first.sessionId, second.sessionId, 'same session id returned');
    assert.equal(first.idempotentReplay, false);
    assert.equal(second.idempotentReplay, true);
    assert.equal(await getBalance(testPool, userId), '90', 'charged exactly once');
    assert.equal(await countSessions(testPool, userId), 1);
    assert.equal(await countBetLedgerRows(testPool, userId), 1);
  });

  it('collapses concurrent duplicates with the same key to one session and one charge', async () => {
    const userId = await seedUser(testPool, 100);
    const gameId = await seedGame(testPool, { minBet: 1, maxBet: 50 });
    const key = 'idem-key-race';

    const [a, b] = await Promise.all([
      initiateGameSession({ userId, gameId, pointsBet: 10, idempotencyKey: key }),
      initiateGameSession({ userId, gameId, pointsBet: 10, idempotencyKey: key }),
    ]);

    assert.equal(a.sessionId, b.sessionId, 'both requests resolve to the same session');
    assert.equal(await getBalance(testPool, userId), '90', 'charged exactly once despite the race');
    assert.equal(await countSessions(testPool, userId), 1);
    assert.equal(await countBetLedgerRows(testPool, userId), 1);
  });

  it('isolates the same key across different users (no cross-account replay)', async () => {
    const userA = await seedUser(testPool, 100);
    const userB = await seedUser(testPool, 100);
    const gameId = await seedGame(testPool, { minBet: 1, maxBet: 50 });
    const sharedKey = 'shared-key';

    const resA = await initiateGameSession({
      userId: userA, gameId, pointsBet: 10, idempotencyKey: sharedKey,
    });
    const resB = await initiateGameSession({
      userId: userB, gameId, pointsBet: 10, idempotencyKey: sharedKey,
    });

    assert.notEqual(resA.sessionId, resB.sessionId, 'each user gets their own session');
    assert.equal(resB.idempotentReplay, false, "B's request is NOT a replay of A's session");
    assert.equal(await getBalance(testPool, userA), '90', 'A charged on their own balance');
    assert.equal(await getBalance(testPool, userB), '90', 'B charged on their own balance');
    assert.equal(await countSessions(testPool, userA), 1);
    assert.equal(await countSessions(testPool, userB), 1);
  });
});

describe('validation & game rules', () => {
  it('rejects a bet outside the game min/max range', async () => {
    const userId = await seedUser(testPool, 1000);
    const gameId = await seedGame(testPool, { minBet: 5, maxBet: 50 });

    await assert.rejects(
      () => initiateGameSession({ userId, gameId, pointsBet: 100 }),
      (err) => err.code === 'VALIDATION_ERROR',
    );
    assert.equal(await getBalance(testPool, userId), '1000', 'balance untouched');
  });

  it('rejects a bet on an inactive game', async () => {
    const userId = await seedUser(testPool, 1000);
    const gameId = await seedGame(testPool, { status: 'MAINTENANCE' });

    await assert.rejects(
      () => initiateGameSession({ userId, gameId, pointsBet: 10 }),
      (err) => err.code === 'CONFLICT',
    );
  });
});

describe('settlement — payout crediting is atomic and idempotent', () => {
  async function startSession(balance = 100, bet = 10) {
    const userId = await seedUser(testPool, balance);
    const gameId = await seedGame(testPool, { minBet: 1, maxBet: 50 });
    const { sessionId } = await initiateGameSession({ userId, gameId, pointsBet: bet });
    return { userId, gameId, sessionId };
  }

  it('credits a win (2x bet) and marks the session SETTLED', async () => {
    const { userId, sessionId } = await startSession(100, 10); // balance now 90

    const out = await settleGameSession({ userId, sessionId, result: { win: true } });

    assert.equal(out.status, 'SETTLED');
    assert.equal(out.payout, '20');
    assert.equal(out.balanceAfter, '110'); // 90 + 20
    assert.equal(await getBalance(testPool, userId), '110');
    assert.equal(await countPayoutLedgerRows(testPool, userId), 1);
    const session = await getSession(testPool, sessionId);
    assert.equal(session.status, 'SETTLED');
    assert.equal(session.payout, '20');
  });

  it('records a loss with no credit and no payout ledger row', async () => {
    const { userId, sessionId } = await startSession(100, 10); // balance now 90

    const out = await settleGameSession({ userId, sessionId, result: { win: false } });

    assert.equal(out.payout, '0');
    assert.equal(await getBalance(testPool, userId), '90'); // unchanged
    assert.equal(await countPayoutLedgerRows(testPool, userId), 0);
    assert.equal((await getSession(testPool, sessionId)).payout, '0');
  });

  it('is idempotent: re-settling returns the stored payout without double-crediting', async () => {
    const { userId, sessionId } = await startSession(100, 10);

    const first = await settleGameSession({ userId, sessionId, result: { win: true } });
    const second = await settleGameSession({ userId, sessionId, result: { win: true } });

    assert.equal(first.idempotentReplay, false);
    assert.equal(second.idempotentReplay, true);
    assert.equal(second.payout, '20');
    assert.equal(await getBalance(testPool, userId), '110'); // credited once
    assert.equal(await countPayoutLedgerRows(testPool, userId), 1);
  });

  it('collapses concurrent double-settle to a single credit', async () => {
    const { userId, sessionId } = await startSession(100, 10);

    const [a, b] = await Promise.all([
      settleGameSession({ userId, sessionId, result: { win: true } }),
      settleGameSession({ userId, sessionId, result: { win: true } }),
    ]);

    assert.equal(a.status, 'SETTLED');
    assert.equal(b.status, 'SETTLED');
    assert.equal(await getBalance(testPool, userId), '110'); // credited exactly once
    assert.equal(await countPayoutLedgerRows(testPool, userId), 1);
  });

  it("refuses to settle another user's session (no cross-account payout)", async () => {
    const { sessionId } = await startSession(100, 10);
    const attacker = await seedUser(testPool, 0);

    await assert.rejects(
      () => settleGameSession({ userId: attacker, sessionId, result: { win: true } }),
      (err) => err.code === 'NOT_FOUND',
    );
    assert.equal((await getSession(testPool, sessionId)).status, 'ACTIVE', 'session untouched');
    assert.equal(await getBalance(testPool, attacker), '0', 'attacker not credited');
  });

  it('rejects settling an unknown session', async () => {
    const userId = await seedUser(testPool, 100);
    await assert.rejects(
      () =>
        settleGameSession({
          userId,
          sessionId: '00000000-0000-4000-8000-000000000000',
          result: { win: true },
        }),
      (err) => err.code === 'NOT_FOUND',
    );
  });

  it('refuses an over-cap payout from a misbehaving engine (no credit, session stays ACTIVE)', async () => {
    const { userId, sessionId } = await startSession(100, 10); // stake 10, balance 90
    // An engine returning a payout far beyond the per-stake sanity ceiling.
    const badEngine = newTestEngine();
    badEngine.settle = () => 1_000_000_000_000;
    setDefaultEngine(badEngine);
    try {
      await assert.rejects(
        () => settleGameSession({ userId, sessionId, result: {} }),
        (err) => err.code === 'INTERNAL_ERROR',
      );
      assert.equal(await getBalance(testPool, userId), '90', 'no payout credited');
      assert.equal(await countPayoutLedgerRows(testPool, userId), 0);
      assert.equal((await getSession(testPool, sessionId)).status, 'ACTIVE', 'session not settled');
    } finally {
      setDefaultEngine(newTestEngine()); // restore for any later tests
    }
  });
});

describe('russian_roulette engine via /process', () => {
  const ROULETTE_KEY = 'russian_roulette';
  const BULLET_LAST = () => [false, false, false, false, false, true];
  const BULLET_FIRST = () => [true, false, false, false, false, false];

  function useRoulette(chamberBuilder) {
    registerEngine(new RussianRouletteEngine(chamberBuilder ? { chamberBuilder } : {}));
  }
  function seedRouletteGame() {
    return seedGame(testPool, { key: ROULETTE_KEY, type: 'LUCK', minBet: 1, maxBet: 1000 });
  }

  it('stores a server-side chamber layout at initiate (and does not leak it)', async () => {
    useRoulette(); // real crypto builder
    const userId = await seedUser(testPool, 100);
    const gameId = await seedRouletteGame();

    const res = await initiateGameSession({ userId, gameId, pointsBet: 10 });

    assert.equal(res.sessionId.length, 36);
    assert.equal(res.chambers, undefined, 'response never contains the layout');
    const meta = await getSessionMetadata(testPool, res.sessionId);
    assert.equal(meta.chambers.length, 6);
    assert.equal(meta.chambers.filter(Boolean).length, 1, 'exactly one bullet');
    assert.equal(meta.position, 0);
    assert.equal(meta.multiplierBps, 10000);
    assert.equal(meta.outcome, 'IN_PROGRESS');
  });

  it('a safe pull survives, grows the multiplier, and keeps the session ACTIVE', async () => {
    useRoulette(BULLET_LAST);
    const userId = await seedUser(testPool, 100);
    const gameId = await seedRouletteGame();
    const { sessionId } = await initiateGameSession({ userId, gameId, pointsBet: 10 });

    const out = await processGameStep({ userId, sessionId, action: 'pull' });

    assert.equal(out.status, 'CONTINUE');
    assert.equal(out.step.survived, true);
    assert.equal(out.settlement, null);
    assert.equal((await getSession(testPool, sessionId)).status, 'ACTIVE');
    const meta = await getSessionMetadata(testPool, sessionId);
    assert.equal(meta.position, 1);
    assert.equal(meta.multiplierBps, 12000, '10000 * 6/5');
  });

  it('a fatal pull auto-settles the session as a loss (payout 0, no credit)', async () => {
    useRoulette(BULLET_FIRST);
    const userId = await seedUser(testPool, 100);
    const gameId = await seedRouletteGame();
    const { sessionId } = await initiateGameSession({ userId, gameId, pointsBet: 10 }); // balance 90

    const out = await processGameStep({ userId, sessionId, action: 'pull' });

    assert.equal(out.status, 'LOSE');
    assert.equal(out.step.survived, false);
    assert.equal(out.settlement.payout, '0');
    assert.equal(await getBalance(testPool, userId), '90', 'no credit on a loss');
    assert.equal(await countPayoutLedgerRows(testPool, userId), 0);
    assert.equal((await getSession(testPool, sessionId)).status, 'SETTLED');
  });

  it('cashing out auto-settles at the current multiplier and credits the win', async () => {
    useRoulette(BULLET_LAST);
    const userId = await seedUser(testPool, 100);
    const gameId = await seedRouletteGame();
    const { sessionId } = await initiateGameSession({ userId, gameId, pointsBet: 10 }); // balance 90

    await processGameStep({ userId, sessionId, action: 'pull' }); // survive -> 1.2x
    const out = await processGameStep({ userId, sessionId, action: 'cashout' });

    assert.equal(out.status, 'WIN');
    // floor(10 * 12000 * 9700 / 1e8) = floor(11.64) = 11
    assert.equal(out.settlement.payout, '11');
    assert.equal(await getBalance(testPool, userId), '101', '90 + 11');
    assert.equal(await countPayoutLedgerRows(testPool, userId), 1);
    assert.equal((await getSession(testPool, sessionId)).status, 'SETTLED');
  });

  it('rejects processing a session that is already settled', async () => {
    useRoulette(BULLET_FIRST);
    const userId = await seedUser(testPool, 100);
    const gameId = await seedRouletteGame();
    const { sessionId } = await initiateGameSession({ userId, gameId, pointsBet: 10 });
    await processGameStep({ userId, sessionId, action: 'pull' }); // dies -> SETTLED

    await assert.rejects(
      () => processGameStep({ userId, sessionId, action: 'pull' }),
      (err) => err.code === 'CONFLICT',
    );
  });

  it("refuses to process another user's session", async () => {
    useRoulette(BULLET_LAST);
    const userId = await seedUser(testPool, 100);
    const gameId = await seedRouletteGame();
    const { sessionId } = await initiateGameSession({ userId, gameId, pointsBet: 10 });
    const attacker = await seedUser(testPool, 0);

    await assert.rejects(
      () => processGameStep({ userId: attacker, sessionId, action: 'pull' }),
      (err) => err.code === 'NOT_FOUND',
    );
    assert.equal((await getSession(testPool, sessionId)).status, 'ACTIVE', 'session untouched');
  });
});
