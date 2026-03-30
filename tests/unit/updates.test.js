const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb } = require('../helpers/db');
const { suppressConsole } = require('../helpers/mocks');

describe('parseImage', () => {
  let parseImage;

  beforeEach(() => {
    delete require.cache[require.resolve('../../src/collectors/updates')];
    parseImage = require('../../src/collectors/updates').parseImage;
  });

  it('parses official image with no tag', () => {
    const result = parseImage('nginx');
    assert.deepEqual(result, { repo: 'library/nginx', tag: 'latest' });
  });

  it('parses official image with tag', () => {
    const result = parseImage('nginx:1.25');
    assert.deepEqual(result, { repo: 'library/nginx', tag: '1.25' });
  });

  it('parses user image with tag', () => {
    const result = parseImage('myuser/myapp:v2');
    assert.deepEqual(result, { repo: 'myuser/myapp', tag: 'v2' });
  });

  it('returns null for non-Docker Hub registries', () => {
    assert.equal(parseImage('ghcr.io/user/app:latest'), null);
    assert.equal(parseImage('registry.example.com/app'), null);
  });

  it('strips digest and defaults to latest tag', () => {
    const result = parseImage('nginx@sha256:abc123');
    assert.deepEqual(result, { repo: 'library/nginx', tag: 'latest' });
  });

  it('parses image with tag and digest', () => {
    const result = parseImage('nginx:alpine@sha256:abc123');
    assert.deepEqual(result, { repo: 'library/nginx', tag: 'alpine' });
  });
});

describe('checkUpdates', () => {
  let db;
  let checkUpdates;
  let restore;
  let https;

  beforeEach(() => {
    restore = suppressConsole();
    db = createTestDb();
    delete require.cache[require.resolve('../../src/collectors/updates')];
    checkUpdates = require('../../src/collectors/updates').checkUpdates;
    https = require('https');
  });

  afterEach(() => {
    db.close();
    restore();
  });

  it('stores update check results in database', async () => {
    const { EventEmitter } = require('events');
    const { mock } = require('node:test');

    // Mock Docker
    const docker = {
      listContainers: async () => [
        { Names: ['/nginx'], Id: 'abc123', Image: 'nginx:alpine', Labels: {} },
      ],
      getImage: () => ({
        inspect: async () => ({ RepoDigests: ['library/nginx@sha256:localdigest'] }),
      }),
    };

    // Mock https.request for both token request and HEAD request
    let callCount = 0;
    const origRequest = https.request;
    https.request = (url, opts, callback) => {
      const res = new EventEmitter();
      callCount++;

      if (typeof url === 'string' && url.includes('auth.docker.io')) {
        res.statusCode = 200;
        res.headers = {};
        process.nextTick(() => {
          callback(res);
          res.emit('data', JSON.stringify({ token: 'test-token-123' }));
          res.emit('end');
        });
      } else {
        res.statusCode = 200;
        res.headers = { 'docker-content-digest': 'sha256:remotedigest' };
        process.nextTick(() => {
          callback(res);
          res.emit('end');
        });
      }

      const req = new EventEmitter();
      req.setTimeout = () => {};
      req.end = () => {};
      req.destroy = () => {};
      return req;
    };

    try {
      await checkUpdates(db, docker);
      const rows = db.prepare('SELECT * FROM update_checks').all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].container_name, 'nginx');
      assert.equal(rows[0].has_update, 1); // digests differ
    } finally {
      https.request = origRequest;
    }
  });

  it('deduplicates by image', async () => {
    const { EventEmitter } = require('events');

    const docker = {
      listContainers: async () => [
        { Names: ['/nginx-1'], Id: 'abc123', Image: 'nginx:alpine', Labels: {} },
        { Names: ['/nginx-2'], Id: 'def456', Image: 'nginx:alpine', Labels: {} },
      ],
      getImage: () => ({
        inspect: async () => ({ RepoDigests: ['library/nginx@sha256:same'] }),
      }),
    };

    const origRequest = https.request;
    https.request = (url, opts, callback) => {
      const res = new EventEmitter();
      if (typeof url === 'string' && url.includes('auth.docker.io')) {
        res.statusCode = 200;
        res.headers = {};
        process.nextTick(() => { callback(res); res.emit('data', JSON.stringify({ token: 't' })); res.emit('end'); });
      } else {
        res.statusCode = 200;
        res.headers = { 'docker-content-digest': 'sha256:same' };
        process.nextTick(() => { callback(res); res.emit('end'); });
      }
      const req = new EventEmitter();
      req.setTimeout = () => {};
      req.end = () => {};
      req.destroy = () => {};
      return req;
    };

    try {
      await checkUpdates(db, docker);
      const rows = db.prepare('SELECT * FROM update_checks').all();
      assert.equal(rows.length, 1); // deduplicated
    } finally {
      https.request = origRequest;
    }
  });

  it('skips non-Docker Hub images', async () => {
    const docker = {
      listContainers: async () => [
        { Names: ['/custom'], Id: 'abc123', Image: 'ghcr.io/user/app:latest', Labels: {} },
      ],
      getImage: () => ({ inspect: async () => ({ RepoDigests: [] }) }),
    };

    await checkUpdates(db, docker);
    const rows = db.prepare('SELECT * FROM update_checks').all();
    assert.equal(rows.length, 0);
  });
});
