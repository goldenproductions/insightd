import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
const { createTestDb, seedContainerSnapshots, seedDiskSnapshots, seedAlertState, seedHttpEndpoints, seedHttpChecks } = require('../helpers/db');
const { ts, NOW } = require('../helpers/fixtures');
const { suppressConsole } = require('../helpers/mocks');

// Mock the sender before requiring evaluator
const nodemailer = require('nodemailer');

describe('evaluateAlerts', () => {
  let db: any;
  let evaluateAlerts: Function;
  let restore: () => void;

  beforeEach(() => {
    restore = suppressConsole();
    mock.method(nodemailer, 'createTransport', () => ({ sendMail: mock.fn(async () => ({ messageId: 't' })) }));
    db = createTestDb();
    delete require.cache[require.resolve('../../src/alerts/evaluator')];
    delete require.cache[require.resolve('../../src/alerts/sender')];
    evaluateAlerts = require('../../src/alerts/evaluator').evaluateAlerts;
  });

  afterEach(() => {
    db.close();
    restore();
    mock.restoreAll();
  });

  const alertsConfig = {
    enabled: true, to: 'test@test.com', cooldownMinutes: 60,
    cpuPercent: 90, memoryMb: 1024, diskPercent: 90,
    restartCount: 3, containerDown: true,
  };

  describe('container_down', () => {
    it('triggers when container transitions from running to exited', () => {
      const t1 = ts(new Date(NOW - 600000));
      const t2 = ts(NOW);
      seedContainerSnapshots(db, [
        { name: 'nginx', status: 'running', at: t1 },
        { name: 'nginx', status: 'exited', at: t2 },
      ]);

      const { triggered } = evaluateAlerts(db, { alerts: alertsConfig });
      assert.equal(triggered.length, 1);
      assert.equal(triggered[0].type, 'container_down');
      assert.equal(triggered[0].target, 'nginx');
    });

    it('does not trigger when container was already exited', () => {
      const t1 = ts(new Date(NOW - 600000));
      const t2 = ts(NOW);
      seedContainerSnapshots(db, [
        { name: 'nginx', status: 'exited', at: t1 },
        { name: 'nginx', status: 'exited', at: t2 },
      ]);

      const { triggered } = evaluateAlerts(db, { alerts: alertsConfig });
      const downs = triggered.filter((a: any) => a.type === 'container_down');
      assert.equal(downs.length, 0);
    });

    it('does not trigger with only one snapshot (no history)', () => {
      seedContainerSnapshots(db, [
        { name: 'nginx', status: 'exited', at: ts(NOW) },
      ]);

      const { triggered } = evaluateAlerts(db, { alerts: alertsConfig });
      const downs = triggered.filter((a: any) => a.type === 'container_down');
      assert.equal(downs.length, 0);
    });

    it('does not trigger when disabled', () => {
      const t1 = ts(new Date(NOW - 600000));
      const t2 = ts(NOW);
      seedContainerSnapshots(db, [
        { name: 'nginx', status: 'running', at: t1 },
        { name: 'nginx', status: 'exited', at: t2 },
      ]);

      const disabledConfig = { ...alertsConfig, containerDown: false };
      const { triggered } = evaluateAlerts(db, { alerts: disabledConfig });
      const downs = triggered.filter((a: any) => a.type === 'container_down');
      assert.equal(downs.length, 0);
    });
  });

  describe('high_cpu', () => {
    it('triggers when CPU exceeds threshold', () => {
      seedContainerSnapshots(db, [
        { name: 'postgres', status: 'running', cpu: 95, mem: 100, at: ts(NOW) },
      ]);

      const { triggered } = evaluateAlerts(db, { alerts: alertsConfig });
      const cpuAlerts = triggered.filter((a: any) => a.type === 'high_cpu');
      assert.equal(cpuAlerts.length, 1);
      assert.equal(cpuAlerts[0].target, 'postgres');
    });

    it('does not trigger below threshold', () => {
      seedContainerSnapshots(db, [
        { name: 'postgres', status: 'running', cpu: 50, mem: 100, at: ts(NOW) },
      ]);

      const { triggered } = evaluateAlerts(db, { alerts: alertsConfig });
      const cpuAlerts = triggered.filter((a: any) => a.type === 'high_cpu');
      assert.equal(cpuAlerts.length, 0);
    });

    it('does not trigger when disabled (threshold 0)', () => {
      seedContainerSnapshots(db, [
        { name: 'postgres', status: 'running', cpu: 95, mem: 100, at: ts(NOW) },
      ]);

      const disabledConfig = { ...alertsConfig, cpuPercent: 0 };
      const { triggered } = evaluateAlerts(db, { alerts: disabledConfig });
      const cpuAlerts = triggered.filter((a: any) => a.type === 'high_cpu');
      assert.equal(cpuAlerts.length, 0);
    });
  });

  describe('high_memory', () => {
    it('triggers when memory exceeds threshold', () => {
      seedContainerSnapshots(db, [
        { name: 'postgres', status: 'running', cpu: 10, mem: 2048, at: ts(NOW) },
      ]);

      const { triggered } = evaluateAlerts(db, { alerts: alertsConfig });
      const memAlerts = triggered.filter((a: any) => a.type === 'high_memory');
      assert.equal(memAlerts.length, 1);
    });

    it('does not trigger below threshold', () => {
      seedContainerSnapshots(db, [
        { name: 'postgres', status: 'running', cpu: 10, mem: 512, at: ts(NOW) },
      ]);

      const { triggered } = evaluateAlerts(db, { alerts: alertsConfig });
      const memAlerts = triggered.filter((a: any) => a.type === 'high_memory');
      assert.equal(memAlerts.length, 0);
    });
  });

  describe('disk_full', () => {
    it('triggers when disk exceeds threshold', () => {
      seedDiskSnapshots(db, [
        { mount: '/', total: 100, used: 95, percent: 95, at: ts(NOW) },
      ]);

      const { triggered } = evaluateAlerts(db, { alerts: alertsConfig });
      const diskAlerts = triggered.filter((a: any) => a.type === 'disk_full');
      assert.equal(diskAlerts.length, 1);
    });

    it('does not trigger below threshold', () => {
      seedDiskSnapshots(db, [
        { mount: '/', total: 100, used: 50, percent: 50, at: ts(NOW) },
      ]);

      const { triggered } = evaluateAlerts(db, { alerts: alertsConfig });
      const diskAlerts = triggered.filter((a: any) => a.type === 'disk_full');
      assert.equal(diskAlerts.length, 0);
    });
  });

  describe('endpoint_down', () => {
    const endpointConfig = {
      ...alertsConfig, endpointDown: true, endpointFailureThreshold: 3,
    };

    it('triggers after N consecutive failures', () => {
      const [id] = seedHttpEndpoints(db, [{ name: 'My API', url: 'https://api.example.com' }]);
      seedHttpChecks(db, [
        { endpointId: id, statusCode: null, isUp: false, error: 'timeout', at: '2026-03-31 10:00:00' },
        { endpointId: id, statusCode: null, isUp: false, error: 'timeout', at: '2026-03-31 10:01:00' },
        { endpointId: id, statusCode: null, isUp: false, error: 'timeout', at: '2026-03-31 10:02:00' },
      ]);

      const { triggered } = evaluateAlerts(db, { alerts: endpointConfig });
      const epAlerts = triggered.filter((a: any) => a.type === 'endpoint_down');
      assert.equal(epAlerts.length, 1);
      assert.equal(epAlerts[0].target, 'My API');
    });

    it('does not trigger with fewer than N failures', () => {
      const [id] = seedHttpEndpoints(db, [{ name: 'My API', url: 'https://api.example.com' }]);
      seedHttpChecks(db, [
        { endpointId: id, statusCode: 200, isUp: true, at: '2026-03-31 10:00:00' },
        { endpointId: id, statusCode: null, isUp: false, error: 'timeout', at: '2026-03-31 10:01:00' },
        { endpointId: id, statusCode: null, isUp: false, error: 'timeout', at: '2026-03-31 10:02:00' },
      ]);

      const { triggered } = evaluateAlerts(db, { alerts: endpointConfig });
      const epAlerts = triggered.filter((a: any) => a.type === 'endpoint_down');
      assert.equal(epAlerts.length, 0);
    });

    it('does not trigger when disabled', () => {
      const [id] = seedHttpEndpoints(db, [{ name: 'My API', url: 'https://api.example.com' }]);
      seedHttpChecks(db, [
        { endpointId: id, statusCode: null, isUp: false, at: '2026-03-31 10:00:00' },
        { endpointId: id, statusCode: null, isUp: false, at: '2026-03-31 10:01:00' },
        { endpointId: id, statusCode: null, isUp: false, at: '2026-03-31 10:02:00' },
      ]);

      const disabledConfig = { ...endpointConfig, endpointDown: false };
      const { triggered } = evaluateAlerts(db, { alerts: disabledConfig });
      const epAlerts = triggered.filter((a: any) => a.type === 'endpoint_down');
      assert.equal(epAlerts.length, 0);
    });
  });

  describe('resolutions', () => {
    it('resolves container_down when container is running again', () => {
      seedContainerSnapshots(db, [
        { name: 'nginx', status: 'running', at: ts(NOW) },
      ]);
      seedAlertState(db, [
        { type: 'container_down', target: 'nginx', triggeredAt: ts(new Date(NOW - 3600000)), lastNotified: ts(new Date(NOW - 3600000)) },
      ]);

      const { resolved } = evaluateAlerts(db, { alerts: alertsConfig });
      assert.equal(resolved.length, 1);
      assert.equal(resolved[0].type, 'container_down');
      assert.equal(resolved[0].isResolution, true);
    });

    it('resolves endpoint_down when endpoint recovers', () => {
      const [id] = seedHttpEndpoints(db, [{ name: 'My API', url: 'https://api.example.com' }]);
      seedHttpChecks(db, [
        { endpointId: id, statusCode: 200, isUp: true, at: ts(NOW) },
      ]);
      seedAlertState(db, [
        { hostId: 'hub', type: 'endpoint_down', target: 'My API', triggeredAt: ts(new Date(NOW - 3600000)), lastNotified: ts(new Date(NOW - 3600000)) },
      ]);

      const { resolved } = evaluateAlerts(db, { alerts: alertsConfig });
      const epResolved = resolved.filter((a: any) => a.type === 'endpoint_down');
      assert.equal(epResolved.length, 1);
      assert.ok(epResolved[0].message.includes('reachable again'));
    });

    it('resolves high_cpu when CPU drops below threshold', () => {
      seedContainerSnapshots(db, [
        { name: 'postgres', status: 'running', cpu: 50, mem: 100, at: ts(NOW) },
      ]);
      seedAlertState(db, [
        { type: 'high_cpu', target: 'postgres', triggeredAt: ts(new Date(NOW - 3600000)), lastNotified: ts(new Date(NOW - 3600000)) },
      ]);

      const { resolved } = evaluateAlerts(db, { alerts: alertsConfig });
      assert.equal(resolved.length, 1);
      assert.equal(resolved[0].type, 'high_cpu');
    });
  });
});

describe('processAlerts', () => {
  let db: any;
  let processAlerts: Function;
  let restore: () => void;

  beforeEach(() => {
    restore = suppressConsole();
    mock.method(nodemailer, 'createTransport', () => ({ sendMail: mock.fn(async () => ({ messageId: 't' })) }));
    db = createTestDb();
    delete require.cache[require.resolve('../../src/alerts/evaluator')];
    delete require.cache[require.resolve('../../src/alerts/sender')];
    processAlerts = require('../../src/alerts/evaluator').processAlerts;
  });

  afterEach(() => {
    db.close();
    restore();
    mock.restoreAll();
  });

  const config = { alerts: { cooldownMinutes: 60 } };

  it('inserts new alert and returns it for sending', () => {
    const triggered = [{ type: 'container_down', hostId: 'local', target: 'nginx', message: 'test' }];
    const toSend = processAlerts(db, config, { triggered, resolved: [] });
    assert.equal(toSend.length, 1);
    assert.equal(toSend[0].reminderNumber, 0);

    const rows = db.prepare('SELECT * FROM alert_state').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].alert_type, 'container_down');
  });

  it('stores message, trigger_value, and threshold in alert_state', () => {
    const triggered = [{
      type: 'high_cpu', hostId: 'local', target: 'redis',
      message: 'Container "redis" on local CPU at 95.5% (threshold: 90%)',
      value: 95.5, threshold: 90,
    }];
    processAlerts(db, config, { triggered, resolved: [] });

    const row = db.prepare('SELECT message, trigger_value, threshold FROM alert_state WHERE target = ?').get('redis');
    assert.equal(row.message, 'Container "redis" on local CPU at 95.5% (threshold: 90%)');
    assert.equal(row.trigger_value, '95.5');
    assert.equal(row.threshold, '90');
  });

  it('stores null threshold for alerts without thresholds', () => {
    const triggered = [{
      type: 'container_down', hostId: 'local', target: 'web',
      message: 'Container "web" on local is down (was running, now exited)',
      value: 'exited',
    }];
    processAlerts(db, config, { triggered, resolved: [] });

    const row = db.prepare('SELECT message, trigger_value, threshold FROM alert_state WHERE target = ?').get('web');
    assert.equal(row.message, 'Container "web" on local is down (was running, now exited)');
    assert.equal(row.trigger_value, 'exited');
    assert.equal(row.threshold, null);
  });

  it('suppresses alert within cooldown period', () => {
    seedAlertState(db, [
      { type: 'container_down', target: 'nginx', triggeredAt: ts(NOW), lastNotified: ts(NOW) },
    ]);

    const triggered = [{ type: 'container_down', hostId: 'local', target: 'nginx', message: 'test' }];
    const toSend = processAlerts(db, config, { triggered, resolved: [] });
    assert.equal(toSend.length, 0); // suppressed
  });

  it('sends reminder when cooldown expired', () => {
    const oldTime = ts(new Date(NOW - 2 * 60 * 60 * 1000)); // 2 hours ago
    seedAlertState(db, [
      { type: 'container_down', target: 'nginx', triggeredAt: oldTime, lastNotified: oldTime },
    ]);

    const triggered = [{ type: 'container_down', hostId: 'local', target: 'nginx', message: 'test' }];
    const toSend = processAlerts(db, config, { triggered, resolved: [] });
    assert.equal(toSend.length, 1);
    assert.equal(toSend[0].reminderNumber, 1); // reminder #1
  });

  it('marks resolved alerts in database', () => {
    seedAlertState(db, [
      { type: 'container_down', target: 'nginx', triggeredAt: ts(NOW), lastNotified: ts(NOW) },
    ]);

    const resolved = [{ type: 'container_down', hostId: 'local', target: 'nginx', message: 'resolved', isResolution: true }];
    const toSend = processAlerts(db, config, { triggered: [], resolved });
    assert.equal(toSend.length, 1);

    const row = db.prepare('SELECT resolved_at FROM alert_state WHERE target = ?').get('nginx');
    assert.ok(row.resolved_at !== null);
  });
});
