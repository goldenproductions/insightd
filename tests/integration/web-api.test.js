const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createTestDb, seedContainerSnapshots, seedDiskSnapshots, seedAlertState, seedUpdateChecks } = require('../helpers/db');
const { ts, NOW } = require('../helpers/fixtures');

const recent = ts(new Date(NOW - 2 * 60 * 1000));

function seedHost(db, hostId, lastSeen) {
  db.prepare('INSERT OR REPLACE INTO hosts (host_id, first_seen, last_seen) VALUES (?, datetime(?), datetime(?))').run(hostId, lastSeen, lastSeen);
}

function fetch(port, path) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body, json: () => JSON.parse(body) });
      });
    }).on('error', reject);
  });
}

function startTestServer(db) {
  // Require fresh to avoid state leaking between tests
  const { startWebServer } = require('../../hub/src/web/server');
  const config = {
    collectIntervalMinutes: 5,
    web: { enabled: true, port: 0, host: '127.0.0.1' },
  };
  return new Promise((resolve) => {
    const server = startWebServer(db, config);
    server.on('listening', () => {
      const port = server.address().port;
      resolve({ server, port });
    });
  });
}

describe('Web API integration', () => {
  let db, server, port;

  beforeEach(async () => {
    db = createTestDb();
    const result = await startTestServer(db);
    server = result.server;
    port = result.port;
  });

  afterEach(() => {
    server.close();
    db.close();
  });

  it('GET /api/health returns ok', async () => {
    const res = await fetch(port, '/api/health');
    assert.equal(res.status, 200);
    const data = res.json();
    assert.equal(data.status, 'ok');
    assert.equal(data.schemaVersion, 9);
  });

  it('GET /api/hosts returns host list', async () => {
    seedHost(db, 'server1', recent);
    const res = await fetch(port, '/api/hosts');
    assert.equal(res.status, 200);
    const data = res.json();
    assert.equal(data.length, 1);
    assert.equal(data[0].host_id, 'server1');
  });

  it('GET /api/hosts/:hostId returns host detail', async () => {
    seedHost(db, 'h1', recent);
    seedContainerSnapshots(db, [
      { hostId: 'h1', name: 'nginx', status: 'running', cpu: 5, mem: 50, at: recent },
    ]);
    const res = await fetch(port, '/api/hosts/h1');
    assert.equal(res.status, 200);
    const data = res.json();
    assert.equal(data.host_id, 'h1');
    assert.equal(data.containers.length, 1);
  });

  it('GET /api/hosts/:hostId returns 404 for unknown host', async () => {
    const res = await fetch(port, '/api/hosts/unknown');
    assert.equal(res.status, 404);
  });

  it('GET /api/hosts/:hostId/containers returns containers', async () => {
    seedContainerSnapshots(db, [
      { hostId: 'h1', name: 'nginx', status: 'running', at: recent },
    ]);
    const res = await fetch(port, '/api/hosts/h1/containers');
    assert.equal(res.status, 200);
    const data = res.json();
    assert.equal(data.length, 1);
  });

  it('GET /api/hosts/:hostId/disk returns disk info', async () => {
    seedDiskSnapshots(db, [
      { hostId: 'h1', mount: '/', percent: 55, at: recent },
    ]);
    const res = await fetch(port, '/api/hosts/h1/disk');
    assert.equal(res.status, 200);
    const data = res.json();
    assert.equal(data.length, 1);
  });

  it('GET /api/dashboard returns aggregate data', async () => {
    seedHost(db, 'h1', recent);
    seedContainerSnapshots(db, [
      { hostId: 'h1', name: 'nginx', status: 'running', at: recent },
    ]);
    const res = await fetch(port, '/api/dashboard');
    assert.equal(res.status, 200);
    const data = res.json();
    assert.equal(data.hostCount, 1);
    assert.equal(data.totalContainers, 1);
    assert.equal(data.containersRunning, 1);
  });

  it('GET /api/alerts returns active alerts', async () => {
    seedAlertState(db, [
      { hostId: 'h1', type: 'container_down', target: 'nginx', triggeredAt: recent },
    ]);
    const res = await fetch(port, '/api/alerts');
    assert.equal(res.status, 200);
    const data = res.json();
    assert.equal(data.length, 1);
  });

  it('GET /api/hosts/:hostId/containers/:name returns container detail', async () => {
    seedContainerSnapshots(db, [
      { hostId: 'h1', name: 'nginx', status: 'running', cpu: 5, mem: 50, at: recent },
    ]);
    const res = await fetch(port, '/api/hosts/h1/containers/nginx');
    assert.equal(res.status, 200);
    const data = res.json();
    assert.equal(data.container_name, 'nginx');
    assert.ok(Array.isArray(data.history));
    assert.ok(Array.isArray(data.alerts));
  });

  it('GET /api/hosts/:hostId/containers/:name returns 404 for unknown', async () => {
    const res = await fetch(port, '/api/hosts/h1/containers/unknown');
    assert.equal(res.status, 404);
  });

  it('GET /api/unknown returns 404', async () => {
    const res = await fetch(port, '/api/unknown');
    assert.equal(res.status, 404);
    const data = res.json();
    assert.equal(data.error, 'Not found');
  });

  it('GET / serves index.html', async () => {
    const res = await fetch(port, '/');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/html'));
  });
});
