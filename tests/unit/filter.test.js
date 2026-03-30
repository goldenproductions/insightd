const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isExcluded } = require('../../hub/src/alerts/filter');

describe('isExcluded', () => {
  it('returns false for empty patterns', () => {
    assert.equal(isExcluded('nginx', ''), false);
    assert.equal(isExcluded('nginx', null), false);
    assert.equal(isExcluded('nginx', undefined), false);
  });

  it('matches exact container name', () => {
    assert.equal(isExcluded('nginx', 'nginx'), true);
    assert.equal(isExcluded('redis', 'nginx'), false);
  });

  it('matches wildcard prefix (dev-*)', () => {
    assert.equal(isExcluded('dev-nginx', 'dev-*'), true);
    assert.equal(isExcluded('dev-redis', 'dev-*'), true);
    assert.equal(isExcluded('prod-nginx', 'dev-*'), false);
  });

  it('matches wildcard suffix (*-test)', () => {
    assert.equal(isExcluded('app-test', '*-test'), true);
    assert.equal(isExcluded('app-prod', '*-test'), false);
  });

  it('matches wildcard in middle (insightd-*-temp)', () => {
    assert.equal(isExcluded('insightd-hub-temp', 'insightd-*-temp'), true);
    assert.equal(isExcluded('insightd-hub-prod', 'insightd-*-temp'), false);
  });

  it('matches multiple patterns', () => {
    assert.equal(isExcluded('dev-nginx', 'dev-*,test-*'), true);
    assert.equal(isExcluded('test-redis', 'dev-*,test-*'), true);
    assert.equal(isExcluded('prod-nginx', 'dev-*,test-*'), false);
  });

  it('handles spaces in pattern list', () => {
    assert.equal(isExcluded('dev-nginx', 'dev-* , test-*'), true);
    assert.equal(isExcluded('test-redis', 'dev-* , test-*'), true);
  });

  it('matches star-only pattern (all containers)', () => {
    assert.equal(isExcluded('anything', '*'), true);
  });

  it('is case-sensitive', () => {
    assert.equal(isExcluded('Nginx', 'nginx'), false);
    assert.equal(isExcluded('nginx', 'Nginx'), false);
  });

  it('escapes regex special characters in patterns', () => {
    assert.equal(isExcluded('app.v2', 'app.v2'), true);
    assert.equal(isExcluded('appXv2', 'app.v2'), false); // dot is literal, not regex any-char
  });
});
