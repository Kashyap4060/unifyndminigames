'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  PERIOD_TYPES,
  toUtcDateString,
  weekStartUtc,
  periodTimeRange,
  isValidPeriodType,
  periodKeyValue,
  redisKey,
  periodsFor,
  parseEntries,
} = require('../../src/leaderboard/keys');

// A Wednesday: 2026-08-05 (UTC). ISO week Monday is 2026-08-03.
const WED = new Date('2026-08-05T10:30:00.000Z');
// A Sunday: 2026-08-09 — its week still starts Monday 2026-08-03.
const SUN = new Date('2026-08-09T23:59:59.000Z');

describe('leaderboard keys', () => {
  it('formats UTC date strings regardless of local time', () => {
    assert.equal(toUtcDateString(WED), '2026-08-05');
    // Just before UTC midnight rollover stays on the same UTC day.
    assert.equal(toUtcDateString(new Date('2026-08-05T23:59:59.999Z')), '2026-08-05');
  });

  it('computes Monday as the week start (UTC) for any weekday', () => {
    assert.equal(toUtcDateString(weekStartUtc(WED)), '2026-08-03'); // Wed -> Mon
    assert.equal(toUtcDateString(weekStartUtc(SUN)), '2026-08-03'); // Sun -> prior Mon
    assert.equal(toUtcDateString(weekStartUtc(new Date('2026-08-03T00:00:00Z'))), '2026-08-03'); // Mon -> Mon
  });

  it('builds redis keys matching the spec format', () => {
    assert.equal(redisKey(PERIOD_TYPES.GLOBAL, WED), 'leaderboard:global');
    assert.equal(redisKey(PERIOD_TYPES.DAILY, WED), 'leaderboard:daily:2026-08-05');
    assert.equal(redisKey(PERIOD_TYPES.WEEKLY, WED), 'leaderboard:weekly:2026-08-03');
  });

  it('derives MySQL period_key values', () => {
    assert.equal(periodKeyValue(PERIOD_TYPES.GLOBAL, WED), 'global');
    assert.equal(periodKeyValue(PERIOD_TYPES.DAILY, WED), '2026-08-05');
    assert.equal(periodKeyValue(PERIOD_TYPES.WEEKLY, WED), '2026-08-03');
  });

  it('periodsFor returns global+daily+weekly with matching redis/period keys', () => {
    const periods = periodsFor(WED);
    assert.deepEqual(
      periods.map((p) => p.type),
      ['global', 'daily', 'weekly'],
    );
    assert.equal(periods[1].redisKey, 'leaderboard:daily:2026-08-05');
    assert.equal(periods[2].periodKey, '2026-08-03');
  });

  it('validates period types', () => {
    assert.equal(isValidPeriodType('daily'), true);
    assert.equal(isValidPeriodType('monthly'), false);
  });

  it('computes UTC [start, end) windows per period (for ledger reconciliation)', () => {
    assert.equal(periodTimeRange(PERIOD_TYPES.GLOBAL, WED), null);
    assert.deepEqual(periodTimeRange(PERIOD_TYPES.DAILY, WED), {
      start: '2026-08-05 00:00:00',
      end: '2026-08-06 00:00:00',
    });
    assert.deepEqual(periodTimeRange(PERIOD_TYPES.WEEKLY, WED), {
      start: '2026-08-03 00:00:00',
      end: '2026-08-10 00:00:00',
    });
  });

  it('parses ZREVRANGE WITHSCORES flat arrays into ranked entries', () => {
    const flat = ['5', '500', '7', '450', '9', '450'];
    assert.deepEqual(parseEntries(flat), [
      { userId: '5', score: 500, rank: 1 },
      { userId: '7', score: 450, rank: 2 },
      { userId: '9', score: 450, rank: 3 },
    ]);
    assert.deepEqual(parseEntries([]), []);
  });
});
