import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const http = require('http');
const { createTestDb, seedContainerSnapshots, seedDiskSnapshots, seedAlertState, seedUpdateChecks, seedServiceGroups, seedGroupMembers, seedBaselines, seedHealthScores } = require('../helpers/db');
const { ts, NOW } = require('../helpers/fixtures');

const recent = ts(new Date(NOW - 2 * 60 * 1000));

function seedHost(db: any, hostId: string, lastSeen: string) {
  db.prepare('INSERT OR REPLACE INTO hosts (host_id, first_seen, last_seen) VALUES (?, datetime(?), datetime(?))').run(hostId, lastSeen, lastSeen);
}

function fetch(port: number, path: string) {
  return new Promise<{ status: number; headers: any; body: string; json: () => any }>((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res: any) => {
      let body = '';
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body, json: () => JSON.parse(body) });
      });
    }).on('error', reject);
  });
}

function fetchMethod(port: number, method: string, path: string) {
  return new Promise<{ status: number; headers: any; body: string; json: () => any }>((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${port}${path}`, { method }, (res: any) => {
      let body = '';
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body, json: () => JSON.parse(body) });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function startTestServer(db: any) {
  // Require fresh to avoid state leaking between tests
  const { startWebServer } = require('../../hub/src/web/server');
  const config = {
    collectIntervalMinutes: 5,
    web: { enabled: true, port: 0, host: '127.0.0.1' },
  };
  return new Promise<{ server: any; port: number }>((resolve) => {
    const server = startWebServer(db, config);
    server.on('listening', () => {
      const port = server.address().port;
      resolve({ server, port });
    });
  });
}

describe('Web API integration', () => {
  let db: any;
  let server: any;
  let port: number;

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
    assert.equal(data.schemaVersion, 15);
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

  it('GET /api/hosts/:hostId/containers/:name/availability returns availability data', async () => {
    const sixHoursAgo = ts(new Date(NOW - 6 * 60 * 60 * 1000));
    const fourHoursAgo = ts(new Date(NOW - 4 * 60 * 60 * 1000));
    const twoHoursAgo = ts(new Date(NOW - 2 * 60 * 60 * 1000));
    seedContainerSnapshots(db, [
      { hostId: 'h1', name: 'nginx', status: 'running', at: sixHoursAgo },
      { hostId: 'h1', name: 'nginx', status: 'exited', at: fourHoursAgo },
      { hostId: 'h1', name: 'nginx', status: 'running', at: twoHoursAgo },
    ]);
    const res = await fetch(port, '/api/hosts/h1/containers/nginx/availability?days=7');
    assert.equal(res.status, 200);
    const data = res.json();
    assert.ok(Array.isArray(data.timeline.slots));
    assert.equal(data.timeline.slots.length, 168);
    assert.ok(Array.isArray(data.incidents));
    assert.equal(data.summary.totalHours, 168);
  });

  it('GET /api/hosts/:hostId/containers/:name/availability returns 404 for unknown', async () => {
    const res = await fetch(port, '/api/hosts/h1/containers/unknown/availability');
    assert.equal(res.status, 404);
  });

  // DELETE /api/hosts/:hostId/containers/:containerName
  it('DELETE container cleans up all DB tables', async () => {
    seedHost(db, 'h1', recent);
    seedContainerSnapshots(db, [
      { hostId: 'h1', name: 'old-test', status: 'exited', at: recent },
    ]);
    seedUpdateChecks(db, [
      { hostId: 'h1', name: 'old-test', at: recent },
    ]);
    seedAlertState(db, [
      { hostId: 'h1', type: 'container_down', target: 'old-test', triggeredAt: recent },
    ]);
    const [groupId] = seedServiceGroups(db, [{ name: 'test-group' }]);
    seedGroupMembers(db, [{ groupId, hostId: 'h1', containerName: 'old-test' }]);
    seedBaselines(db, [
      { entityType: 'container', entityId: 'h1/old-test' },
    ]);
    seedHealthScores(db, [
      { entityType: 'container', entityId: 'h1/old-test' },
    ]);

    // Also seed another container that should NOT be deleted
    seedContainerSnapshots(db, [
      { hostId: 'h1', name: 'keep-this', status: 'running', at: recent },
    ]);

    const res = await fetchMethod(port, 'DELETE', '/api/hosts/h1/containers/old-test');
    assert.equal(res.status, 200);
    const data = res.json();
    assert.equal(data.deleted, true);

    // Verify all records for old-test are gone
    assert.equal(db.prepare('SELECT COUNT(*) as c FROM container_snapshots WHERE container_name = ?').get('old-test').c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) as c FROM update_checks WHERE container_name = ?').get('old-test').c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) as c FROM alert_state WHERE target = ?').get('old-test').c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) as c FROM service_group_members WHERE container_name = ?').get('old-test').c, 0);
    assert.equal(db.prepare("SELECT COUNT(*) as c FROM baselines WHERE entity_id = ?").get('h1/old-test').c, 0);
    assert.equal(db.prepare("SELECT COUNT(*) as c FROM health_scores WHERE entity_id = ?").get('h1/old-test').c, 0);

    // Verify other container data is intact
    assert.equal(db.prepare('SELECT COUNT(*) as c FROM container_snapshots WHERE container_name = ?').get('keep-this').c, 1);
  });

  it('DELETE container works even without Docker context', async () => {
    seedHost(db, 'h1', recent);
    seedContainerSnapshots(db, [
      { hostId: 'h1', name: 'gone', status: 'exited', at: recent },
    ]);
    const res = await fetchMethod(port, 'DELETE', '/api/hosts/h1/containers/gone');
    assert.equal(res.status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) as c FROM container_snapshots WHERE container_name = ?').get('gone').c, 0);
  });
});
