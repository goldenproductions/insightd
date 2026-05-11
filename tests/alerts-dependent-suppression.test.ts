import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
const { bootstrap } = require('../hub/src/db/schema');
const { processAlerts } = require('../hub/src/alerts/evaluator');

const cfg = (overrides: any = {}) => ({
  smtp: { host: '', port: 0, user: '', pass: '', from: '' },
  alerts: {
    cooldownMinutes: 60, reminderBackoff: true, reminderMaxMinutes: 1440,
    mailCriticalOnly: false, suppressDependents: true,
    flapStabilizeMinutes: 0, diskCriticalPercent: 95,
    ...overrides,
  },
});

function addHost(db: any, host: string, cluster: string | null = null) {
  db.prepare(`INSERT INTO hosts (host_id, first_seen, last_seen, runtime_type, proxmox_cluster_id)
              VALUES (?, datetime('now'), datetime('now'), 'docker', ?)`).run(host, cluster);
}

test('host_offline suppresses container_down mails on same host', () => {
  const db = new Database(':memory:'); bootstrap(db);
  addHost(db, 'h1');
  // Parent fires first
  processAlerts(db, cfg(), {
    triggered: [{ type: 'host_offline', hostId: 'h1', target: 'system', message: 'down' }],
    resolved: [],
  });
  // Children fire while parent active
  const children = ['nginx', 'redis', 'postgres'].map(c => ({
    type: 'container_down', hostId: 'h1', target: c, message: `${c} down`,
  }));
  const toSend = processAlerts(db, cfg(), { triggered: children, resolved: [] });
  assert.equal(toSend.length, 0, 'children should be fully suppressed');
  for (const c of ['nginx', 'redis', 'postgres']) {
    const row = db.prepare("SELECT suppressed_by_state_id FROM alert_state WHERE alert_type = 'container_down' AND target = ?").get(c) as any;
    assert.ok(row?.suppressed_by_state_id, `${c} should have suppressed_by_state_id set`);
  }
});

test('suppressDependents=false sends all (back-compat)', () => {
  const db = new Database(':memory:'); bootstrap(db);
  addHost(db, 'h1');
  processAlerts(db, cfg({ suppressDependents: false }), {
    triggered: [{ type: 'host_offline', hostId: 'h1', target: 'system', message: 'down' }],
    resolved: [],
  });
  const toSend = processAlerts(db, cfg({ suppressDependents: false }), {
    triggered: [{ type: 'container_down', hostId: 'h1', target: 'nginx', message: 'down' }],
    resolved: [],
  });
  assert.equal(toSend.length, 1);
});

test('retroactive suppression — parent fires after children', () => {
  const db = new Database(':memory:'); bootstrap(db);
  addHost(db, 'h1');
  // Children fire first
  processAlerts(db, cfg(), {
    triggered: ['nginx', 'redis'].map(c => ({ type: 'container_down', hostId: 'h1', target: c, message: 'down' })),
    resolved: [],
  });
  // Parent fires now — children get retroactively stamped
  processAlerts(db, cfg(), {
    triggered: [{ type: 'host_offline', hostId: 'h1', target: 'system', message: 'down' }],
    resolved: [],
  });
  for (const c of ['nginx', 'redis']) {
    const row = db.prepare("SELECT suppressed_by_state_id FROM alert_state WHERE alert_type = 'container_down' AND target = ?").get(c) as any;
    assert.ok(row?.suppressed_by_state_id, `${c} should be retroactively suppressed`);
  }
});

test('cross-host suppression does not leak', () => {
  const db = new Database(':memory:'); bootstrap(db);
  addHost(db, 'h1'); addHost(db, 'h2');
  processAlerts(db, cfg(), {
    triggered: [{ type: 'host_offline', hostId: 'h1', target: 'system', message: 'down' }],
    resolved: [],
  });
  const toSend = processAlerts(db, cfg(), {
    triggered: [{ type: 'container_down', hostId: 'h2', target: 'nginx', message: 'down' }],
    resolved: [],
  });
  assert.equal(toSend.length, 1, 'different host should still mail');
});
