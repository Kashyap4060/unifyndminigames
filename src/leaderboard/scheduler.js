'use strict';

const nodeCron = require('node-cron');

/**
 * Runs one reconciliation tick for a period, with an overlap guard so a slow
 * run can't stack on the next tick, and error isolation so a failure never
 * throws out of the scheduler. `state` is a shared {period: boolean} map.
 * Exported for unit testing without real cron timers.
 */
async function runReconcile(leaderboardService, period, state, logger) {
  if (state[period]) {
    logger.warn(`[leaderboard] reconcile(${period}) still running — skipping this tick`);
    return false;
  }
  state[period] = true;
  try {
    const n = await leaderboardService.reconcileFromLedger(period);
    logger.log(`[leaderboard] reconcile(${period}) complete: ${n} users`);
    return true;
  } catch (err) {
    logger.error(`[leaderboard] reconcile(${period}) failed: ${err.message}`);
    return false;
  } finally {
    state[period] = false;
  }
}

/**
 * Schedules periodic `leaderboardService.reconcileFromLedger(period)` jobs.
 * Cron runs in UTC to match the UTC-derived period keys/windows.
 *
 * @param {object} deps
 * @param {import('./leaderboardService').LeaderboardService} deps.leaderboardService
 * @param {{daily?:string, weekly?:string, global?:string}} deps.schedules  cron expressions
 * @param {Console} [deps.logger]
 * @param {typeof nodeCron} [deps.cron]  injectable for tests
 * @returns {{ start: () => number, stop: () => void }}
 */
function createReconciliationScheduler({ leaderboardService, schedules, logger = console, cron = nodeCron }) {
  const tasks = [];
  const state = { global: false, daily: false, weekly: false };

  function start() {
    for (const [period, expr] of Object.entries(schedules)) {
      if (!expr) continue; // empty disables that period
      if (!cron.validate(expr)) {
        logger.error(`[leaderboard] invalid cron for ${period}: "${expr}" — not scheduled`);
        continue;
      }
      tasks.push(cron.schedule(expr, () => runReconcile(leaderboardService, period, state, logger), {
        timezone: 'UTC',
      }));
      logger.log(`[leaderboard] reconcile(${period}) scheduled: "${expr}" (UTC)`);
    }
    return tasks.length;
  }

  function stop() {
    for (const task of tasks) {
      try {
        task.stop();
      } catch (_err) {
        /* best effort */
      }
    }
    tasks.length = 0;
  }

  return { start, stop };
}

module.exports = { createReconciliationScheduler, runReconcile };
