import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
const { createTestDb, seedHostSnapshots } = require('../helpers/db');
const { ts, NOW } = require('../helpers/fixtures');
const { suppressConsole } = require('../helpers/mocks');

// Hub evaluator (not the standalone one at src/alerts/evaluator).
const nodemailer = require('nodemailer');

describe('evaluateAlerts — node conditions (hub)', () => {
  let db: any;
  let evaluateAlerts: Function;
  let restore: () => void;

  beforeEach(() => {
    restore = suppressConsole();
    mock.method(nodemailer, 'createTransport', () => ({ sendMail: mock.fn(async () => ({ messageId: 't' })) }));
    db = createTestDb();
    delete require.cache[require.resolve('../../hub/src/alerts/evaluator')];
    delete require.cache[require.resolve('../../hub/src/alerts/sender')];
    evaluateAlerts = require('../../hub/src/alerts/evaluator').evaluateAlerts;

    // Seed a host_snapshot so the host loop picks up `k3d-0`
    seedHostSnapshots(db, [{ hostId: 'k3d-0', at: ts(NOW) }]);
  });

  afterEach(() => {
    db.close();
    restore();
    mock.restoreAll();
  });

  const cfg = {
    enabled: true, to: 't@t.com', cooldownMinutes: 60,
    containerDown: true, restartCount: 3,
    cpuPercent: 90, memoryMb: 1024, diskPercent: 90,
    hostCpuPercent: 0, hostMemoryAvailableMb: 0, hostLoadThreshold: 0,
    hostOffline: false, hostOfflineMinutes: 0,
    containerUnhealthy: false, excludeContainers: '',
    endpointDown: false, endpointFailureThreshold: 3,
  };

  function insertCondition(hostId: string, type: string, status: string, reason: string | null = null, message: string | null = null): void {
    db.prepare(`
      INSERT INTO node_conditions (host_id, type, status, reason, message, last_heartbeat_at, last_transition_at, observed_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now'))
      ON CONFLICT(host_id, type) DO UPDATE SET status = excluded.status, reason = excluded.reason, message = excluded.message
    `).run(hostId, type, status, reason, message);
  }

  it('fires node_pressure when MemoryPressure flips to True', () => {
    insertCondition('k3d-0', 'MemoryPressure', 'True', 'KubeletHasInsufficientMemory', 'attempting to reclaim memory');
    const { triggered } = evaluateAlerts(db, { alerts: cfg });
    const pressure = triggered.filter((a: any) => a.type === 'node_pressure');
    assert.equal(pressure.length, 1);
    assert.equal(pressure[0].target, 'MemoryPressure');
    assert.equal(pressure[0].hostId, 'k3d-0');
    assert.match(pressure[0].message, /MemoryPressure=True/);
  });

  it('does not fire node_pressure when all pressures are False', () => {
    insertCondition('k3d-0', 'MemoryPressure', 'False');
    insertCondition('k3d-0', 'DiskPressure', 'False');
    insertCondition('k3d-0', 'PIDPressure', 'False');
    const { triggered } = evaluateAlerts(db, { alerts: cfg });
    const pressure = triggered.filter((a: any) => a.type === 'node_pressure');
    assert.equal(pressure.length, 0);
  });

  it('fires one node_pressure per True pressure condition (independent targets)', () => {
    insertCondition('k3d-0', 'MemoryPressure', 'True');
    insertCondition('k3d-0', 'DiskPressure', 'True');
    insertCondition('k3d-0', 'PIDPressure', 'False');
    const { triggered } = evaluateAlerts(db, { alerts: cfg });
    const pressure = triggered.filter((a: any) => a.type === 'node_pressure');
    assert.equal(pressure.length, 2);
    const targets = pressure.map((a: any) => a.target).sort();
    assert.deepEqual(targets, ['DiskPressure', 'MemoryPressure']);
  });

  it('fires node_not_ready when Ready = Unknown', () => {
    insertCondition('k3d-0', 'Ready', 'Unknown', 'NodeStatusUnknown', 'Kubelet stopped posting');
    const { triggered } = evaluateAlerts(db, { alerts: cfg });
    const notReady = triggered.filter((a: any) => a.type === 'node_not_ready');
    assert.equal(notReady.length, 1);
    assert.equal(notReady[0].target, 'Ready');
    assert.match(notReady[0].message, /status=Unknown/);
  });

  it('fires node_not_ready when Ready = False', () => {
    insertCondition('k3d-0', 'Ready', 'False', 'KubeletNotReady', 'runtime not ready');
    const { triggered } = evaluateAlerts(db, { alerts: cfg });
    const notReady = triggered.filter((a: any) => a.type === 'node_not_ready');
    assert.equal(notReady.length, 1);
  });

  it('does not fire node_not_ready when Ready = True', () => {
    insertCondition('k3d-0', 'Ready', 'True');
    const { triggered } = evaluateAlerts(db, { alerts: cfg });
    const notReady = triggered.filter((a: any) => a.type === 'node_not_ready');
    assert.equal(notReady.length, 0);
  });

  it('resolves node_pressure when condition flips to False', () => {
    // Simulate a prior triggered alert already in alert_state.
    insertCondition('k3d-0', 'MemoryPressure', 'False');
    db.prepare(`
      INSERT INTO alert_state (host_id, alert_type, target, triggered_at)
      VALUES (?, 'node_pressure', 'MemoryPressure', ?)
    `).run('k3d-0', ts(new Date(NOW - 600_000)));

    const { resolved } = evaluateAlerts(db, { alerts: cfg });
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].type, 'node_pressure');
    assert.equal(resolved[0].target, 'MemoryPressure');
  });

  it('resolves node_not_ready when Ready flips back to True', () => {
    insertCondition('k3d-0', 'Ready', 'True');
    db.prepare(`
      INSERT INTO alert_state (host_id, alert_type, target, triggered_at)
      VALUES (?, 'node_not_ready', 'Ready', ?)
    `).run('k3d-0', ts(new Date(NOW - 600_000)));

    const { resolved } = evaluateAlerts(db, { alerts: cfg });
    const nr = resolved.filter((r: any) => r.type === 'node_not_ready');
    assert.equal(nr.length, 1);
  });
});
