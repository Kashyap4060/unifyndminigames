'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { runReconcile, createReconciliationScheduler } = require('../../src/leaderboard/scheduler');

const silentLogger = { log() {}, warn() {}, error() {} };

describe('runReconcile', () => {
  it('runs reconcileFromLedger and clears the running flag', async () => {
    const calls = [];
    const svc = { reconcileFromLedger: async (p) => { calls.push(p); return 4; } };
    const state = { daily: false };

    const ok = await runReconcile(svc, 'daily', state, silentLogger);
    assert.equal(ok, true);
    assert.deepEqual(calls, ['daily']);
    assert.equal(state.daily, false, 'running flag reset');
  });

  it('skips (overlap guard) when a run for the same period is in progress', async () => {
    let called = 0;
    const svc = { reconcileFromLedger: async () => { called += 1; return 0; } };
    const state = { daily: true }; // already running

    const ok = await runReconcile(svc, 'daily', state, silentLogger);
    assert.equal(ok, false);
    assert.equal(called, 0, 'must not start a concurrent reconcile');
  });

  it('swallows errors and resets the flag', async () => {
    const svc = { reconcileFromLedger: async () => { throw new Error('db down'); } };
    const state = { global: false };

    const ok = await runReconcile(svc, 'global', state, silentLogger);
    assert.equal(ok, false);
    assert.equal(state.global, false, 'running flag reset even on failure');
  });
});

describe('createReconciliationScheduler', () => {
  function makeFakeCron() {
    const scheduled = [];
    return {
      scheduled,
      validate: (expr) => expr !== 'BAD',
      schedule: (expr, fn, opts) => {
        const task = { expr, fn, opts, stopped: false, stop() { this.stopped = true; } };
        scheduled.push(task);
        return task;
      },
    };
  }

  it('schedules a job per non-empty, valid expression in UTC', () => {
    const cron = makeFakeCron();
    const sched = createReconciliationScheduler({
      leaderboardService: { reconcileFromLedger: async () => 0 },
      schedules: { daily: '15 * * * *', weekly: '30 * * * *', global: '0 3 * * *' },
      logger: silentLogger,
      cron,
    });

    const count = sched.start();
    assert.equal(count, 3);
    assert.deepEqual(cron.scheduled.map((t) => t.expr), ['15 * * * *', '30 * * * *', '0 3 * * *']);
    assert.ok(cron.scheduled.every((t) => t.opts.timezone === 'UTC'));

    sched.stop();
    assert.ok(cron.scheduled.every((t) => t.stopped), 'stop() stops every task');
  });

  it('skips empty and invalid cron expressions', () => {
    const cron = makeFakeCron();
    const sched = createReconciliationScheduler({
      leaderboardService: { reconcileFromLedger: async () => 0 },
      schedules: { daily: '', weekly: 'BAD', global: '0 3 * * *' },
      logger: silentLogger,
      cron,
    });
    assert.equal(sched.start(), 1); // only global is valid + non-empty
    assert.deepEqual(cron.scheduled.map((t) => t.expr), ['0 3 * * *']);
  });

  it('a scheduled tick invokes reconcileFromLedger for its period', async () => {
    const cron = makeFakeCron();
    const calls = [];
    const sched = createReconciliationScheduler({
      leaderboardService: { reconcileFromLedger: async (p) => { calls.push(p); return 1; } },
      schedules: { daily: '15 * * * *' },
      logger: silentLogger,
      cron,
    });
    sched.start();
    await cron.scheduled[0].fn(); // simulate cron firing
    assert.deepEqual(calls, ['daily']);
  });
});
