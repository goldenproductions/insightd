import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
const { isRateLimited } = require('../../hub/src/web/rate-limit');

describe('rate limiter', () => {
  it('allows requests under the limit', () => {
    const req = { socket: { remoteAddress: '10.0.0.1' } };
    assert.equal(isRateLimited(req), false);
  });

  it('blocks after exceeding limit from same IP', () => {
    const req = { socket: { remoteAddress: '10.0.0.99' } };
    // 120 is the limit — send 121
    for (let i = 0; i < 120; i++) {
      isRateLimited(req);
    }
    assert.equal(isRateLimited(req), true);
  });

  it('allows requests from different IPs independently', () => {
    const req1 = { socket: { remoteAddress: '10.0.0.50' } };
    const req2 = { socket: { remoteAddress: '10.0.0.51' } };
    for (let i = 0; i < 120; i++) {
      isRateLimited(req1);
    }
    assert.equal(isRateLimited(req1), true);
    assert.equal(isRateLimited(req2), false);
  });
});
