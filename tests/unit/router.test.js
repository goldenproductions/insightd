const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createRouter } = require('../../hub/src/web/router');

describe('router', () => {
  it('matches exact paths', () => {
    const router = createRouter();
    router.add('GET', '/api/health', () => 'health');
    const result = router.match('GET', '/api/health');
    assert.ok(result);
    assert.deepEqual(result.params, {});
  });

  it('extracts path params', () => {
    const router = createRouter();
    router.add('GET', '/api/hosts/:hostId', () => 'host');
    const result = router.match('GET', '/api/hosts/server1');
    assert.ok(result);
    assert.equal(result.params.hostId, 'server1');
  });

  it('extracts multiple path params', () => {
    const router = createRouter();
    router.add('GET', '/api/hosts/:hostId/:sub', () => 'sub');
    const result = router.match('GET', '/api/hosts/server1/containers');
    assert.ok(result);
    assert.equal(result.params.hostId, 'server1');
    assert.equal(result.params.sub, 'containers');
  });

  it('returns null for no match', () => {
    const router = createRouter();
    router.add('GET', '/api/health', () => 'health');
    assert.equal(router.match('GET', '/api/unknown'), null);
  });

  it('returns null for wrong method', () => {
    const router = createRouter();
    router.add('GET', '/api/health', () => 'health');
    assert.equal(router.match('POST', '/api/health'), null);
  });

  it('decodes URI components in params', () => {
    const router = createRouter();
    router.add('GET', '/api/hosts/:hostId', () => 'host');
    const result = router.match('GET', '/api/hosts/my%20server');
    assert.equal(result.params.hostId, 'my server');
  });

  it('matches first route when multiple match', () => {
    const router = createRouter();
    router.add('GET', '/api/hosts/:hostId', () => 'param');
    router.add('GET', '/api/hosts/special', () => 'exact');
    const result = router.match('GET', '/api/hosts/special');
    assert.ok(result);
    // First route matches since :hostId catches everything
    assert.equal(result.params.hostId, 'special');
  });
});
