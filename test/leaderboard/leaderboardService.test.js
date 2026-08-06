'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { LeaderboardService } = require('../../src/leaderboard/leaderboardService');

const NOW = new Date('2026-08-05T10:00:00.000Z'); // daily 2026-08-05, weekly 2026-08-03

// ---- Fakes -----------------------------------------------------------------

function makeFakePipeline(store) {
  const calls = [];
  const pipe = {};
  for (const m of ['zadd', 'zincrby', 'expire', 'del', 'rename']) {
    pipe[m] = (...args) => {
      calls.push([m, ...args]);
      return pipe;
    };
  }
  pipe.exec = async () => {
    if (store.execThrows) throw new Error('redis pipeline down');
    store.pipelineCalls.push(...calls);
    return calls.map(() => [null, 'OK']);
  };
  return pipe;
}

function makeFakeRedis({ status = 'ready' } = {}) {
  const store = { pipelineCalls: [], execThrows: false, zrevrange: null };
  return {
    status,
    pipelineCalls: store.pipelineCalls,
    setExecThrows(v) {
      store.execThrows = v;
    },
    _store: store,
    pipeline: () => makeFakePipeline(store),
    zrevrange: async (...args) => {
      if (typeof store.zrevrange === 'function') return store.zrevrange(...args);
      throw new Error('not stubbed');
    },
    zrevrank: async () => store.zrevrank,
    zscore: async () => store.zscore,
    del: async () => 1,
    setZrevrange(fn) {
      store.zrevrange = fn;
    },
    setZrevrank(v) {
      store.zrevrank = v;
    },
    setZscore(v) {
      store.zscore = v;
    },
  };
}

function makeFakeRepo(overrides = {}) {
  const calls = {
    upsertScore: [],
    incrementScore: [],
    getTop: [],
    getRank: [],
    getScore: [],
    reconcilePeriodFromLedger: [],
  };
  return {
    calls,
    upsertScore: async (...a) => {
      calls.upsertScore.push(a);
    },
    incrementScore: async (...a) => {
      calls.incrementScore.push(a);
    },
    getTop: async (...a) => {
      calls.getTop.push(a);
      return overrides.getTop || [];
    },
    getRank: async (...a) => {
      calls.getRank.push(a);
      return overrides.getRank ?? null;
    },
    getScore: async (...a) => {
      calls.getScore.push(a);
      return overrides.getScore ?? null;
    },
    reconcilePeriodFromLedger: async (...a) => {
      calls.reconcilePeriodFromLedger.push(a);
      return overrides.reconcileCount ?? 0;
    },
  };
}

const silentLogger = { log() {}, warn() {}, error() {} };
const TTL = { daily: 100, weekly: 200 };

function makeService(redis, repo) {
  return new LeaderboardService({ redis, repository: repo, ttl: TTL, logger: silentLogger });
}

// ---- Tests -----------------------------------------------------------------

describe('LeaderboardService — writes persist to MySQL first, cache best-effort', () => {
  let redis;
  let repo;
  beforeEach(() => {
    redis = makeFakeRedis();
    repo = makeFakeRepo();
  });

  it('addScore upserts all three periods in MySQL and ZADDs to Redis', async () => {
    const svc = makeService(redis, repo);
    await svc.addScore(42, 500, { now: NOW });

    assert.equal(repo.calls.upsertScore.length, 3); // global, daily, weekly
    const zadds = redis.pipelineCalls.filter((c) => c[0] === 'zadd');
    assert.equal(zadds.length, 3);
    assert.deepEqual(zadds[0], ['zadd', 'leaderboard:global', 500, 42]);
    // TTL applied to daily+weekly only (global ttl = 0).
    const expires = redis.pipelineCalls.filter((c) => c[0] === 'expire');
    assert.equal(expires.length, 2);
  });

  it('incrementScore uses MySQL upsert-add and Redis ZINCRBY', async () => {
    const svc = makeService(redis, repo);
    await svc.incrementScore(42, 25, { now: NOW });

    assert.equal(repo.calls.incrementScore.length, 3);
    const zincrs = redis.pipelineCalls.filter((c) => c[0] === 'zincrby');
    assert.equal(zincrs.length, 3);
    assert.deepEqual(zincrs[0], ['zincrby', 'leaderboard:global', 25, 42]);
  });

  it('still persists to MySQL when Redis is unavailable (write skipped, no throw)', async () => {
    const svc = makeService(makeFakeRedis({ status: 'end' }), repo);
    await svc.addScore(42, 500, { now: NOW });
    assert.equal(repo.calls.upsertScore.length, 3);
  });

  it('does not throw when the Redis pipeline exec fails (MySQL already persisted)', async () => {
    redis.setExecThrows(true);
    const svc = makeService(redis, repo);
    await svc.addScore(42, 500, { now: NOW }); // must resolve
    assert.equal(repo.calls.upsertScore.length, 3);
  });
});

describe('LeaderboardService — reads serve from Redis, fall back to MySQL', () => {
  it('serves top players from Redis when available and warm', async () => {
    const redis = makeFakeRedis();
    redis.setZrevrange(async () => ['5', '900', '7', '800']);
    const repo = makeFakeRepo();
    const svc = makeService(redis, repo);

    const res = await svc.getTopPlayers('global', { limit: 100, now: NOW });
    assert.equal(res.source, 'redis');
    assert.deepEqual(res.entries, [
      { userId: '5', score: 900, rank: 1 },
      { userId: '7', score: 800, rank: 2 },
    ]);
    assert.equal(repo.calls.getTop.length, 0); // never hit MySQL
  });

  it('falls back to MySQL when Redis is unavailable', async () => {
    const repo = makeFakeRepo({ getTop: [{ user_id: '3', score: 700 }] });
    const svc = makeService(makeFakeRedis({ status: 'connecting' }), repo);

    const res = await svc.getTopPlayers('daily', { now: NOW });
    assert.equal(res.source, 'mysql');
    assert.deepEqual(res.entries, [{ userId: '3', score: 700, rank: 1 }]);
    assert.deepEqual(repo.calls.getTop[0], ['daily', '2026-08-05', 100]);
  });

  it('falls back to MySQL when the Redis read throws', async () => {
    const redis = makeFakeRedis();
    redis.setZrevrange(async () => {
      throw new Error('redis down mid-read');
    });
    const repo = makeFakeRepo({ getTop: [{ user_id: '9', score: 10 }] });
    const svc = makeService(redis, repo);

    const res = await svc.getTopPlayers('weekly', { now: NOW });
    assert.equal(res.source, 'mysql');
    assert.deepEqual(repo.calls.getTop[0], ['weekly', '2026-08-03', 100]);
  });

  it('falls back to MySQL when Redis returns an empty (cold) key', async () => {
    const redis = makeFakeRedis();
    redis.setZrevrange(async () => []);
    const repo = makeFakeRepo({ getTop: [{ user_id: '1', score: 5 }] });
    const svc = makeService(redis, repo);

    const res = await svc.getTopPlayers('global', { now: NOW });
    assert.equal(res.source, 'mysql');
  });

  it('getPlayerRank uses Redis ZREVRANK (0-based -> 1-based), else MySQL', async () => {
    const redis = makeFakeRedis();
    redis.setZrevrank(2); // 0-based
    let svc = makeService(redis, makeFakeRepo());
    assert.equal(await svc.getPlayerRank(42, 'global', { now: NOW }), 3);

    // Redis unavailable -> MySQL
    svc = makeService(makeFakeRedis({ status: 'end' }), makeFakeRepo({ getRank: 7 }));
    assert.equal(await svc.getPlayerRank(42, 'global', { now: NOW }), 7);
  });

  it('getPlayerScore uses Redis ZSCORE, else MySQL', async () => {
    const redis = makeFakeRedis();
    redis.setZscore('455');
    let svc = makeService(redis, makeFakeRepo());
    assert.equal(await svc.getPlayerScore(42, 'daily', { now: NOW }), 455);

    svc = makeService(makeFakeRedis({ status: 'end' }), makeFakeRepo({ getScore: 12 }));
    assert.equal(await svc.getPlayerScore(42, 'daily', { now: NOW }), 12);
  });
});

describe('LeaderboardService — reconcileFromLedger repairs from the ledger, then refreshes Redis', () => {
  it('reconciles the correct period window and rebuilds the Redis cache', async () => {
    const redis = makeFakeRedis();
    const repo = makeFakeRepo({ reconcileCount: 3, getTop: [{ user_id: '5', score: 900 }] });
    const svc = makeService(redis, repo);

    const count = await svc.reconcileFromLedger('daily', { now: NOW });

    assert.equal(count, 3);
    // Reconciled the daily period with its UTC [start, end) window from the ledger.
    assert.deepEqual(repo.calls.reconcilePeriodFromLedger[0], [
      'daily',
      '2026-08-05',
      { start: '2026-08-05 00:00:00', end: '2026-08-06 00:00:00' },
    ]);
    // Then rehydrated Redis from the now-authoritative MySQL table, via a temp
    // key that is atomically RENAMEd over the live key.
    assert.equal(repo.calls.getTop.length, 1);
    const zadds = redis.pipelineCalls.filter((c) => c[0] === 'zadd');
    assert.equal(zadds.length, 1);
    const tempKey = zadds[0][1];
    assert.match(tempKey, /^leaderboard:daily:2026-08-05:rebuild:/);
    assert.deepEqual(zadds[0].slice(2), [900, '5']); // score, member
    const renames = redis.pipelineCalls.filter((c) => c[0] === 'rename');
    assert.deepEqual(renames[0], ['rename', tempKey, 'leaderboard:daily:2026-08-05']);
  });

  it('uses an all-time window (null range) for the global period', async () => {
    const repo = makeFakeRepo({ reconcileCount: 1, getTop: [] });
    const svc = makeService(makeFakeRedis(), repo);
    await svc.reconcileFromLedger('global', { now: NOW });
    assert.deepEqual(repo.calls.reconcilePeriodFromLedger[0], ['global', 'global', null]);
  });
});

describe('LeaderboardService — validation', () => {
  const svc = makeService(makeFakeRedis(), makeFakeRepo());

  it('rejects bad userId / score / periodType / limit', async () => {
    await assert.rejects(() => svc.addScore(0, 10, { now: NOW }), (e) => e.code === 'VALIDATION_ERROR');
    await assert.rejects(() => svc.addScore(1, NaN, { now: NOW }), (e) => e.code === 'VALIDATION_ERROR');
    await assert.rejects(
      () => svc.getTopPlayers('monthly', { now: NOW }),
      (e) => e.code === 'VALIDATION_ERROR',
    );
    await assert.rejects(
      () => svc.getTopPlayers('global', { limit: 0, now: NOW }),
      (e) => e.code === 'VALIDATION_ERROR',
    );
  });
});
