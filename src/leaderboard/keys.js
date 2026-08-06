'use strict';

/**
 * Pure helpers for leaderboard Redis keys and MySQL period identifiers.
 *
 * All dates are computed in UTC so the same key is produced regardless of the
 * server's local timezone — critical when multiple app instances write to one
 * Redis/MySQL and must agree on "today" / "this week".
 */

const PREFIX = 'leaderboard';

const PERIOD_TYPES = Object.freeze({
  GLOBAL: 'global',
  DAILY: 'daily',
  WEEKLY: 'weekly',
});

const ALL_PERIOD_TYPES = Object.freeze([
  PERIOD_TYPES.GLOBAL,
  PERIOD_TYPES.DAILY,
  PERIOD_TYPES.WEEKLY,
]);

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** YYYY-MM-DD in UTC. */
function toUtcDateString(date) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/** Monday (UTC) of the ISO week containing `date`. */
function weekStartUtc(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay(); // 0=Sun .. 6=Sat
  const shiftToMonday = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + shiftToMonday);
  return d;
}

/** UTC midnight of the given date. */
function utcMidnight(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addUtcDays(date, days) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/** 'YYYY-MM-DD 00:00:00' (UTC) — a MySQL DATETIME boundary. */
function toUtcDateTimeString(date) {
  return `${toUtcDateString(date)} 00:00:00`;
}

/**
 * The [start, end) UTC datetime window for a period, used to sum ledger credits
 * during reconciliation. Returns null for 'global' (all-time, no time filter).
 * @returns {{start:string, end:string}|null}
 */
function periodTimeRange(periodType, date) {
  switch (periodType) {
    case PERIOD_TYPES.GLOBAL:
      return null;
    case PERIOD_TYPES.DAILY: {
      const start = utcMidnight(date);
      return { start: toUtcDateTimeString(start), end: toUtcDateTimeString(addUtcDays(start, 1)) };
    }
    case PERIOD_TYPES.WEEKLY: {
      const start = weekStartUtc(date);
      return { start: toUtcDateTimeString(start), end: toUtcDateTimeString(addUtcDays(start, 7)) };
    }
    default:
      throw new Error(`Unknown period type: ${periodType}`);
  }
}

function isValidPeriodType(periodType) {
  return ALL_PERIOD_TYPES.includes(periodType);
}

/**
 * The MySQL `period_key` value for a period type at a given time.
 * global -> 'global'; daily -> '2026-08-05'; weekly -> week-start '2026-08-03'.
 */
function periodKeyValue(periodType, date) {
  switch (periodType) {
    case PERIOD_TYPES.GLOBAL:
      return 'global';
    case PERIOD_TYPES.DAILY:
      return toUtcDateString(date);
    case PERIOD_TYPES.WEEKLY:
      return toUtcDateString(weekStartUtc(date));
    default:
      throw new Error(`Unknown period type: ${periodType}`);
  }
}

/** The Redis key for a period type at a given time, e.g. leaderboard:daily:2026-08-05. */
function redisKey(periodType, date) {
  if (periodType === PERIOD_TYPES.GLOBAL) return `${PREFIX}:global`;
  return `${PREFIX}:${periodType}:${periodKeyValue(periodType, date)}`;
}

/** The set of periods a single score write must touch (global + daily + weekly). */
function periodsFor(date) {
  return ALL_PERIOD_TYPES.map((type) => ({
    type,
    redisKey: redisKey(type, date),
    periodKey: periodKeyValue(type, date),
  }));
}

/**
 * Parse the flat [member, score, member, score, ...] array returned by
 * ioredis `ZREVRANGE ... WITHSCORES` into ranked leaderboard entries.
 * @param {string[]} flat
 * @param {number} [startRank=1]
 */
function parseEntries(flat, startRank = 1) {
  const entries = [];
  for (let i = 0; i < flat.length; i += 2) {
    entries.push({
      userId: String(flat[i]),
      score: Number(flat[i + 1]),
      rank: startRank + i / 2,
    });
  }
  return entries;
}

module.exports = {
  PREFIX,
  PERIOD_TYPES,
  ALL_PERIOD_TYPES,
  toUtcDateString,
  weekStartUtc,
  periodTimeRange,
  isValidPeriodType,
  periodKeyValue,
  redisKey,
  periodsFor,
  parseEntries,
};
