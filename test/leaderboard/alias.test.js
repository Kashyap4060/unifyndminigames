'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { aliasForUser } = require('../../src/leaderboard/alias');

describe('aliasForUser', () => {
  const secret = 'test-alias-secret';

  it('is stable for the same user + secret', () => {
    assert.equal(aliasForUser(42, secret), aliasForUser(42, secret));
    assert.equal(aliasForUser('42', secret), aliasForUser(42, secret)); // string/number equivalent
  });

  it('differs per user and per secret', () => {
    assert.notEqual(aliasForUser(42, secret), aliasForUser(43, secret));
    assert.notEqual(aliasForUser(42, secret), aliasForUser(42, 'other-secret'));
  });

  it('is opaque: prefixed, fixed-length, and never contains the raw id', () => {
    const alias = aliasForUser(1234567, secret);
    assert.match(alias, /^p_[0-9a-f]{12}$/);
    assert.ok(!alias.includes('1234567'));
  });
});
