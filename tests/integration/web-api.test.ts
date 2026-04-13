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

function fetchMethod(port: number, method: string, path: string, body?: any) {
  return new Promise<{ status: number; headers: any; body: string; json: () => any }>((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {};
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(Buffer.byteLength(payload)); }
    const req = http.request(`http://127.0.0.1:${port}${path}`, { method, headers }, (res: any) => {
      let resBody = '';
      res.on('data', (chunk: string) => { resBody += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body: resBody, json: () => JSON.parse(resBody) });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
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
    assert.equal(data.schemaVersion, 22);
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

  // PUT /api/hosts/:hostId/group — manual override for host grouping
  it('PUT host group sets manual override that wins over agent value', async () => {
    seedHost(db, 'h1', recent);
    db.prepare("UPDATE hosts SET host_group = ? WHERE host_id = ?").run('from-agent', 'h1');

    // Resolved value starts as the agent value
    let res = await fetch(port, '/api/hosts');
    assert.equal(res.json()[0].host_group, 'from-agent');
    assert.equal(res.json()[0].host_group_override, null);

    // Set manual override
    res = await fetchMethod(port, 'PUT', '/api/hosts/h1/group', { host_group: 'manual-set' });
    assert.equal(res.status, 200);
    assert.equal(res.json().host_group_override, 'manual-set');

    // Resolved value reflects the override
    res = await fetch(port, '/api/hosts');
    assert.equal(res.json()[0].host_group, 'manual-set');
    assert.equal(res.json()[0].host_group_override, 'manual-set');

    // Even when the agent ingests a new value, the override still wins (resolved is COALESCE-driven)
    db.prepare("UPDATE hosts SET host_group = ? WHERE host_id = ?").run('agent-changed', 'h1');
    res = await fetch(port, '/api/hosts');
    assert.equal(res.json()[0].host_group, 'manual-set');
  });

  it('PUT host group with null body sets manually-ungrouped (empty override)', async () => {
    seedHost(db, 'h1', recent);
    db.prepare("UPDATE hosts SET host_group = ? WHERE host_id = ?").run('from-agent', 'h1');

    const res = await fetchMethod(port, 'PUT', '/api/hosts/h1/group', { host_group: null });
    assert.equal(res.status, 200);
    assert.equal(res.json().host_group_override, '');

    // Resolved value is empty string (UI treats this as ungrouped)
    const list = await fetch(port, '/api/hosts');
    assert.equal(list.json()[0].host_group, '');
  });

  it('PUT host group returns 404 for unknown host', async () => {
    const res = await fetchMethod(port, 'PUT', '/api/hosts/nope/group', { host_group: 'foo' });
    assert.equal(res.status, 404);
  });

  // DELETE /api/hosts/:hostId/group — clear override, fall back to agent value
  it('DELETE host group clears override and resolved value falls back to agent', async () => {
    seedHost(db, 'h1', recent);
    db.prepare("UPDATE hosts SET host_group = ?, host_group_override = ? WHERE host_id = ?")
      .run('from-agent', 'manual-set', 'h1');

    let res = await fetch(port, '/api/hosts');
    assert.equal(res.json()[0].host_group, 'manual-set');

    res = await fetchMethod(port, 'DELETE', '/api/hosts/h1/group');
    assert.equal(res.status, 200);
    assert.equal(res.json().reset, true);

    res = await fetch(port, '/api/hosts');
    assert.equal(res.json()[0].host_group, 'from-agent');
    assert.equal(res.json()[0].host_group_override, null);
  });

  // ----- Setup + agent setup -----
  it('GET /api/setup/status returns mode and auth flags', async () => {
    const res = await fetch(port, '/api/setup/status');
    assert.equal(res.status, 200);
    const data = res.json();
    assert.ok('setupComplete' in data);
    assert.ok('mode' in data);
    assert.ok('authEnabled' in data);
  });

  it('GET /api/agent-setup returns MQTT details and image', async () => {
    const res = await fetch(port, '/api/agent-setup');
    assert.equal(res.status, 200);
    const data = res.json();
    assert.ok(data.mqttUrl.startsWith('mqtt://'));
    assert.equal(typeof data.image, 'string');
  });

  // ----- Settings -----
  it('GET /api/settings returns categories', async () => {
    const res = await fetch(port, '/api/settings');
    assert.equal(res.status, 200);
    const data = res.json();
    assert.ok(data.categories);
    assert.equal(typeof data.categories, 'object');
  });

  // ----- Webhooks -----
  it('webhooks: create → list → get → update → delete', async () => {
    // Create
    let res = await fetchMethod(port, 'POST', '/api/webhooks', {
      name: 'Test Slack', type: 'slack', url: 'https://hooks.slack.com/services/foo',
      on_alert: true, on_digest: false, enabled: true,
    });
    assert.equal(res.status, 201);
    const id = res.json().id;
    assert.ok(id);

    // List
    res = await fetch(port, '/api/webhooks');
    assert.equal(res.status, 200);
    const list = res.json();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'Test Slack');

    // Get
    res = await fetch(port, `/api/webhooks/${id}`);
    assert.equal(res.status, 200);
    assert.equal(res.json().type, 'slack');

    // Update
    res = await fetchMethod(port, 'PUT', `/api/webhooks/${id}`, { enabled: false });
    assert.equal(res.status, 200);
    res = await fetch(port, `/api/webhooks/${id}`);
    assert.equal(res.json().enabled, 0);

    // Delete
    res = await fetchMethod(port, 'DELETE', `/api/webhooks/${id}`);
    assert.equal(res.status, 200);
    assert.equal(res.json().deleted, true);

    // Confirm gone
    res = await fetch(port, `/api/webhooks/${id}`);
    assert.equal(res.status, 404);
  });

  it('POST /api/webhooks rejects invalid type', async () => {
    const res = await fetchMethod(port, 'POST', '/api/webhooks', {
      name: 'Bad', type: 'pigeon', url: 'https://example.com',
    });
    assert.equal(res.status, 400);
    assert.match(res.json().error, /type must be one of/);
  });

  it('POST /api/webhooks rejects missing URL', async () => {
    const res = await fetchMethod(port, 'POST', '/api/webhooks', {
      name: 'NoUrl', type: 'slack',
    });
    assert.equal(res.status, 400);
  });

  it('PUT /api/webhooks/:id returns 404 for unknown id', async () => {
    const res = await fetchMethod(port, 'PUT', '/api/webhooks/9999', { enabled: false });
    assert.equal(res.status, 404);
  });

  // ----- HTTP Endpoints -----
  it('endpoints: create → list → get → update → delete', async () => {
    let res = await fetchMethod(port, 'POST', '/api/endpoints', {
      name: 'My Site', url: 'https://example.com', expectedStatus: 200,
      intervalSeconds: 60, timeoutMs: 5000,
    });
    assert.equal(res.status, 201);
    const id = res.json().id;
    assert.ok(id);

    res = await fetch(port, '/api/endpoints');
    assert.equal(res.status, 200);
    assert.equal(res.json().length, 1);

    res = await fetch(port, `/api/endpoints/${id}`);
    assert.equal(res.status, 200);
    assert.equal(res.json().name, 'My Site');

    res = await fetchMethod(port, 'PUT', `/api/endpoints/${id}`, { name: 'Renamed' });
    assert.equal(res.status, 200);
    res = await fetch(port, `/api/endpoints/${id}`);
    assert.equal(res.json().name, 'Renamed');

    res = await fetchMethod(port, 'DELETE', `/api/endpoints/${id}`);
    assert.equal(res.status, 200);
    res = await fetch(port, `/api/endpoints/${id}`);
    assert.equal(res.status, 404);
  });

  it('POST /api/endpoints rejects malformed URL', async () => {
    const res = await fetchMethod(port, 'POST', '/api/endpoints', {
      name: 'Bad', url: 'ftp://nope',
    });
    assert.equal(res.status, 400);
    assert.match(res.json().error, /url is required/);
  });

  it('POST /api/endpoints rejects out-of-range interval', async () => {
    const res = await fetchMethod(port, 'POST', '/api/endpoints', {
      name: 'Bad', url: 'https://example.com', intervalSeconds: 5,
    });
    assert.equal(res.status, 400);
    assert.match(res.json().error, /intervalSeconds/);
  });

  it('GET /api/endpoints/:id/checks returns checks list', async () => {
    let res = await fetchMethod(port, 'POST', '/api/endpoints', {
      name: 'Site', url: 'https://example.com',
    });
    const id = res.json().id;
    res = await fetch(port, `/api/endpoints/${id}/checks`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json()));
  });

  // ----- Service Groups -----
  it('groups: create → list → get → update → add member → remove member → delete', async () => {
    seedHost(db, 'h1', recent);
    seedContainerSnapshots(db, [{ hostId: 'h1', name: 'nginx', status: 'running', at: recent }]);

    let res = await fetchMethod(port, 'POST', '/api/groups', {
      name: 'Web', description: 'Web stack', icon: '🌐', color: '#3b82f6',
    });
    assert.equal(res.status, 201);
    const id = res.json().id;
    assert.ok(id);

    res = await fetch(port, '/api/groups');
    assert.equal(res.status, 200);
    assert.ok(res.json().some((g: any) => g.id === id));

    res = await fetch(port, `/api/groups/${id}`);
    assert.equal(res.status, 200);
    assert.equal(res.json().name, 'Web');

    res = await fetchMethod(port, 'PUT', `/api/groups/${id}`, { description: 'Updated description' });
    assert.equal(res.status, 200);

    res = await fetchMethod(port, 'POST', `/api/groups/${id}/members`, {
      hostId: 'h1', containerName: 'nginx',
    });
    assert.equal(res.status, 200);

    res = await fetch(port, `/api/groups/${id}`);
    assert.ok(res.json().members.some((m: any) => m.container_name === 'nginx'));

    res = await fetchMethod(port, 'DELETE', `/api/groups/${id}/members`, {
      hostId: 'h1', containerName: 'nginx',
    });
    assert.equal(res.status, 200);

    res = await fetchMethod(port, 'DELETE', `/api/groups/${id}`);
    assert.equal(res.status, 200);
  });

  it('POST /api/groups rejects empty name', async () => {
    const res = await fetchMethod(port, 'POST', '/api/groups', { name: '' });
    assert.equal(res.status, 400);
  });

  it('POST /api/groups returns 409 on duplicate name', async () => {
    await fetchMethod(port, 'POST', '/api/groups', { name: 'Dup' });
    const res = await fetchMethod(port, 'POST', '/api/groups', { name: 'Dup' });
    assert.equal(res.status, 409);
  });

  it('POST /api/groups/:id/members rejects missing fields', async () => {
    const create = await fetchMethod(port, 'POST', '/api/groups', { name: 'X' });
    const id = create.json().id;
    const res = await fetchMethod(port, 'POST', `/api/groups/${id}/members`, { hostId: 'h1' });
    assert.equal(res.status, 400);
  });

  it('GET /api/groups/:id returns 404 for unknown id', async () => {
    const res = await fetch(port, '/api/groups/9999');
    assert.equal(res.status, 404);
  });

  // ----- Insights feedback -----
  it('POST /api/insights/feedback persists feedback and accepts updates', async () => {
    let res = await fetchMethod(port, 'POST', '/api/insights/feedback', {
      entity_type: 'host', entity_id: 'h1', category: 'cpu', metric: null, helpful: true,
    });
    assert.equal(res.status, 200);
    assert.equal(res.json().ok, true);

    let row = db.prepare("SELECT helpful FROM insight_feedback WHERE entity_id = 'h1' AND category = 'cpu'").get();
    assert.equal(row.helpful, 1);

    // Same key, flipped vote — UPSERT should overwrite
    res = await fetchMethod(port, 'POST', '/api/insights/feedback', {
      entity_type: 'host', entity_id: 'h1', category: 'cpu', metric: null, helpful: false,
    });
    assert.equal(res.status, 200);
    row = db.prepare("SELECT helpful FROM insight_feedback WHERE entity_id = 'h1' AND category = 'cpu'").get();
    assert.equal(row.helpful, 0);
  });

  it('POST /api/insights/feedback rejects missing fields', async () => {
    const res = await fetchMethod(port, 'POST', '/api/insights/feedback', { entity_type: 'host' });
    assert.equal(res.status, 400);
  });

  it('GET /api/insights/feedback returns the feedback list', async () => {
    await fetchMethod(port, 'POST', '/api/insights/feedback', {
      entity_type: 'container', entity_id: 'h1/nginx', category: 'memory', metric: 'memory_mb', helpful: true,
    });
    const res = await fetch(port, '/api/insights/feedback');
    assert.equal(res.status, 200);
    const list = res.json();
    assert.equal(list.length, 1);
    assert.equal(list[0].entity_id, 'h1/nginx');
  });

  // ----- Smoke tests for read-only endpoints -----
  it('GET /api/rankings returns top CPU/memory containers', async () => {
    seedContainerSnapshots(db, [
      { hostId: 'h1', name: 'a', cpu: 50, mem: 200, at: recent },
      { hostId: 'h1', name: 'b', cpu: 20, mem: 500, at: recent },
    ]);
    const res = await fetch(port, '/api/rankings?limit=5');
    assert.equal(res.status, 200);
    const data = res.json();
    assert.ok(Array.isArray(data.byCpu));
    assert.ok(Array.isArray(data.byMemory));
  });

  it('GET /api/hosts/:hostId/timeline returns slot data', async () => {
    seedContainerSnapshots(db, [{ hostId: 'h1', name: 'nginx', status: 'running', at: recent }]);
    const res = await fetch(port, '/api/hosts/h1/timeline?days=7');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json()));
  });

  it('GET /api/hosts/:hostId/events returns events array', async () => {
    seedContainerSnapshots(db, [{ hostId: 'h1', name: 'nginx', status: 'running', at: recent }]);
    const res = await fetch(port, '/api/hosts/h1/events?days=7');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json()));
  });

  it('GET /api/hosts/:hostId/trends returns trends shape', async () => {
    seedContainerSnapshots(db, [{ hostId: 'h1', name: 'nginx', cpu: 5, mem: 50, at: recent }]);
    const res = await fetch(port, '/api/hosts/h1/trends');
    assert.equal(res.status, 200);
    const data = res.json();
    assert.ok('containers' in data);
  });

  it('GET /api/baselines/:type/:id returns baselines for entity', async () => {
    seedBaselines(db, [
      { entityType: 'container', entityId: 'h1/nginx', metric: 'cpu_percent', sampleCount: 500 },
    ]);
    const res = await fetch(port, '/api/baselines/container/h1%2Fnginx');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json()));
  });

  it('GET /api/health-scores returns all scores', async () => {
    seedHealthScores(db, [{ entityType: 'host', entityId: 'h1', score: 95 }]);
    const res = await fetch(port, '/api/health-scores');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json()));
  });

  it('GET /api/health-scores/:type/:id returns parsed score', async () => {
    seedHealthScores(db, [{ entityType: 'host', entityId: 'h1', score: 88 }]);
    const res = await fetch(port, '/api/health-scores/host/h1');
    assert.equal(res.status, 200);
    const data = res.json();
    assert.equal(data.score, 88);
    assert.equal(typeof data.factors, 'object');
  });

  it('GET /api/health-scores/:type/:id returns 404 when missing', async () => {
    const res = await fetch(port, '/api/health-scores/host/unknown');
    assert.equal(res.status, 404);
  });

  it('GET /api/insights returns insights list', async () => {
    const res = await fetch(port, '/api/insights');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json()));
  });

  it('GET /api/version-check returns version info', async () => {
    const res = await fetch(port, '/api/version-check');
    assert.equal(res.status, 200);
    const data = res.json();
    assert.ok('currentVersion' in data);
  });

  it('GET /api/image-updates returns array', async () => {
    const res = await fetch(port, '/api/image-updates');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json()));
  });

  it('POST /api/auth without an admin password returns 401', async () => {
    // Auth is disabled in tests (no admin password seeded), so authenticate() returns null
    const res = await fetchMethod(port, 'POST', '/api/auth', { password: 'whatever' });
    assert.equal(res.status, 401);
  });
});

describe('AI diagnose API', () => {
  let db: any;
  let server: any;
  let port: number;
  let aiConfig: any;
  let origFetch: typeof globalThis.fetch;

  async function startWithConfig(cfg: any) {
    const { startWebServer } = require('../../hub/src/web/server');
    return new Promise<{ server: any; port: number }>((resolve) => {
      const s = startWebServer(db, cfg);
      s.on('listening', () => resolve({ server: s, port: s.address().port }));
    });
  }

  beforeEach(async () => {
    db = createTestDb();
    origFetch = globalThis.fetch;
    aiConfig = {
      collectIntervalMinutes: 5,
      web: { enabled: true, port: 0, host: '127.0.0.1' },
      smtp: { host: '', port: 587, user: '', pass: '', from: '' },
      alerts: {
        enabled: false, to: '', cooldownMinutes: 60,
        cpuPercent: 90, memoryMb: 0, diskPercent: 90, restartCount: 3,
        containerDown: true, hostCpuPercent: 90, hostMemoryAvailableMb: 0,
        hostLoadThreshold: 0, containerUnhealthy: true,
        excludeContainers: '', endpointDown: true, endpointFailureThreshold: 3,
      },
      ai: {
        enabled: true,
        geminiApiKey: 'test-key',
        geminiModel: 'gemini-2.5-flash',
        requestTimeoutMs: 5000,
        cacheMaxAgeMs: 24 * 60 * 60 * 1000,
      },
    };
  });

  afterEach(() => {
    if (server) server.close();
    db.close();
    globalThis.fetch = origFetch;
  });

  it('GET /api/ai-diagnose/status reports disabled when no key', async () => {
    const cfg = { ...aiConfig, ai: { ...aiConfig.ai, enabled: false, geminiApiKey: '' } };
    ({ server, port } = await startWithConfig(cfg));
    const res = await fetch(port, '/api/ai-diagnose/status');
    assert.equal(res.status, 200);
    assert.equal(res.json().enabled, false);
  });

  it('GET /api/ai-diagnose/status reports enabled with model', async () => {
    ({ server, port } = await startWithConfig(aiConfig));
    const res = await fetch(port, '/api/ai-diagnose/status');
    assert.equal(res.json().enabled, true);
    assert.equal(res.json().model, 'gemini-2.5-flash');
  });

  it('POST /api/hosts/:h/containers/:c/ai-diagnose returns 503 when disabled', async () => {
    const cfg = { ...aiConfig, ai: { ...aiConfig.ai, enabled: false, geminiApiKey: '' } };
    ({ server, port } = await startWithConfig(cfg));
    seedContainerSnapshots(db, [{ hostId: 'h1', name: 'nginx', status: 'running', health: 'unhealthy', at: recent }]);
    const res = await fetchMethod(port, 'POST', '/api/hosts/h1/containers/nginx/ai-diagnose');
    assert.equal(res.status, 503);
    assert.equal(res.json().error, 'ai_disabled');
  });

  it('POST /api/hosts/:h/containers/:c/ai-diagnose returns 404 when container missing', async () => {
    ({ server, port } = await startWithConfig(aiConfig));
    const res = await fetchMethod(port, 'POST', '/api/hosts/h1/containers/ghost/ai-diagnose');
    assert.equal(res.status, 404);
  });

  it('POST ai-diagnose happy path: calls Gemini, persists, subsequent call is cached', async () => {
    ({ server, port } = await startWithConfig(aiConfig));
    seedContainerSnapshots(db, [
      { hostId: 'h1', name: 'nginx', status: 'running', health: 'unhealthy', cpu: 50, mem: 400, at: recent },
    ]);

    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify({
          rootCause: 'Upstream unreachable',
          reasoning: 'Logs indicate connection refused coincident with host pressure.',
          suggestedFix: 'Verify upstream service and restart container.',
          confidence: 0.85,
          caveats: ['Could also be DNS'],
        }) }] } }],
        usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 80 },
      }), { status: 200 });
    }) as any;

    const first = await fetchMethod(port, 'POST', '/api/hosts/h1/containers/nginx/ai-diagnose');
    assert.equal(first.status, 200);
    const body1 = first.json();
    assert.equal(body1.rootCause, 'Upstream unreachable');
    assert.equal(body1.cached, false);
    assert.equal(body1.model, 'gemini-2.5-flash');
    assert.equal(body1.confidence, 0.85);
    assert.deepEqual(body1.caveats, ['Could also be DNS']);
    assert.equal(calls, 1);

    const row = db.prepare('SELECT * FROM ai_diagnoses WHERE host_id = ? AND container_name = ?').get('h1', 'nginx');
    assert.ok(row);
    assert.equal(row.root_cause, 'Upstream unreachable');

    // Second call should hit the cache since context didn't change
    const second = await fetchMethod(port, 'POST', '/api/hosts/h1/containers/nginx/ai-diagnose');
    assert.equal(second.status, 200);
    assert.equal(second.json().cached, true);
    assert.equal(calls, 1); // no new Gemini call
  });

  it('GET ai-diagnose returns 404 before any run, then the persisted diagnosis', async () => {
    ({ server, port } = await startWithConfig(aiConfig));
    seedContainerSnapshots(db, [
      { hostId: 'h1', name: 'nginx', status: 'running', health: 'unhealthy', at: recent },
    ]);

    let r = await fetch(port, '/api/hosts/h1/containers/nginx/ai-diagnose');
    assert.equal(r.status, 404);

    globalThis.fetch = (async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        rootCause: 'rc', reasoning: 'rea', suggestedFix: 'fix', confidence: 0.5, caveats: [],
      }) }] } }],
    }), { status: 200 })) as any;

    await fetchMethod(port, 'POST', '/api/hosts/h1/containers/nginx/ai-diagnose');
    r = await fetch(port, '/api/hosts/h1/containers/nginx/ai-diagnose');
    assert.equal(r.status, 200);
    assert.equal(r.json().rootCause, 'rc');
  });

  it('DB-set API key enables AI diagnose even with no env/base-config key', async () => {
    // Simulate a fresh install where no GEMINI_API_KEY env var exists and user
    // configures the key via Settings page. The DB setting should flip enabled=true.
    const noKeyConfig = {
      ...aiConfig,
      ai: { ...aiConfig.ai, enabled: false, geminiApiKey: '' },
    };
    ({ server, port } = await startWithConfig(noKeyConfig));
    // Initially disabled
    let status = await fetch(port, '/api/ai-diagnose/status');
    assert.equal(status.json().enabled, false);

    // Simulate the settings page saving a key into the DB
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('ai.geminiApiKey', 'db-key', datetime('now'))").run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('ai.geminiModel', 'gemini-1.5-pro', datetime('now'))").run();

    // Now it should report enabled with the DB-set model
    status = await fetch(port, '/api/ai-diagnose/status');
    assert.equal(status.json().enabled, true);
    assert.equal(status.json().model, 'gemini-1.5-pro');

    // And a POST should succeed using the DB key
    seedContainerSnapshots(db, [
      { hostId: 'h1', name: 'nginx', status: 'running', health: 'unhealthy', at: recent },
    ]);
    let capturedUrl = '';
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify({
          rootCause: 'rc', reasoning: 'r', suggestedFix: 'f', confidence: 0.6, caveats: [],
        }) }] } }],
      }), { status: 200 });
    }) as any;
    const res = await fetchMethod(port, 'POST', '/api/hosts/h1/containers/nginx/ai-diagnose');
    assert.equal(res.status, 200);
    assert.ok(capturedUrl.includes('key=db-key'), 'expected DB key to be used in request');
    assert.ok(capturedUrl.includes('gemini-1.5-pro:generateContent'), 'expected DB-set model to be used');
  });

  it('POST ai-diagnose returns 502 when Gemini fails', async () => {
    ({ server, port } = await startWithConfig(aiConfig));
    seedContainerSnapshots(db, [
      { hostId: 'h1', name: 'nginx', status: 'running', health: 'unhealthy', at: recent },
    ]);
    globalThis.fetch = (async () => new Response('boom', { status: 500 })) as any;
    const res = await fetchMethod(port, 'POST', '/api/hosts/h1/containers/nginx/ai-diagnose');
    assert.equal(res.status, 502);
    assert.equal(res.json().error, 'ai_call_failed');
  });

  it('POST ai-diagnose returns 429 with Retry-After on Gemini rate limit', async () => {
    ({ server, port } = await startWithConfig(aiConfig));
    seedContainerSnapshots(db, [
      { hostId: 'h1', name: 'nginx', status: 'running', health: 'unhealthy', at: recent },
    ]);
    const rateLimitBody = JSON.stringify({
      error: {
        code: 429,
        message: 'quota exceeded',
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '30s' }],
      },
    });
    globalThis.fetch = (async () => new Response(rateLimitBody, { status: 429 })) as any;
    const res = await fetchMethod(port, 'POST', '/api/hosts/h1/containers/nginx/ai-diagnose');
    assert.equal(res.status, 429);
    assert.equal(res.headers['retry-after'], '30');
    const body = res.json();
    assert.equal(body.error, 'rate_limited');
    assert.equal(body.retryAfterSeconds, 30);
  });
});
