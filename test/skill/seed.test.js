'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { signToken, verifyToken, deriveHiddenSeed, seededInt } = require('../../src/skill/seed');

const SID = '11111111-1111-4111-8111-111111111111';
const SECRET = 'test-seed-secret';

describe('skill seed tokens', () => {
  it('round-trips a signed token', () => {
    const token = signToken(SID, 1000, SECRET);
    assert.equal(verifyToken(SID, 1000, token, SECRET), true);
  });

  it('rejects tampered token, wrong issuedAt, wrong secret, non-string', () => {
    const token = signToken(SID, 1000, SECRET);
    assert.equal(verifyToken(SID, 1000, `${token}x`, SECRET), false);
    assert.equal(verifyToken(SID, 1001, token, SECRET), false);
    assert.equal(verifyToken(SID, 1000, token, 'other'), false);
    assert.equal(verifyToken(SID, 1000, undefined, SECRET), false);
    assert.equal(verifyToken(SID, 1000, 12345, SECRET), false);
  });

  it('a token for one session does not verify for another', () => {
    const token = signToken(SID, 1000, SECRET);
    assert.equal(verifyToken('22222222-2222-4222-8222-222222222222', 1000, token, SECRET), false);
  });
});

describe('skill hidden seed', () => {
  it('is deterministic and varies by session/user/game', () => {
    const a = deriveHiddenSeed(SID, 1, 2, SECRET);
    assert.equal(a, deriveHiddenSeed(SID, 1, 2, SECRET));
    assert.notEqual(a, deriveHiddenSeed(SID, 1, 3, SECRET));
    assert.notEqual(a, deriveHiddenSeed(SID, 2, 2, SECRET));
  });

  it('hidden seed is NOT derivable from the public token (namespaced)', () => {
    const token = signToken(SID, 1000, SECRET);
    const hidden = deriveHiddenSeed(SID, 1, 2, SECRET);
    assert.ok(!token.includes(hidden));
    assert.notEqual(token.split('.')[1], hidden);
  });
});

describe('seededInt', () => {
  it('is deterministic and within [0, max)', () => {
    const hex = deriveHiddenSeed(SID, 1, 2, SECRET);
    const v = seededInt(hex, 20);
    assert.equal(v, seededInt(hex, 20));
    assert.ok(Number.isInteger(v) && v >= 0 && v < 20);
  });

  it('throws on non-positive max', () => {
    assert.throws(() => seededInt('abcdef', 0), RangeError);
  });
});
