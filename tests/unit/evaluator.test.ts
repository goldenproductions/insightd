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

  describe('host_offline', () => {
    const offlineConfig = { ...alertsConfig, hostOffline: true, hostOfflineMinutes: 15 };

    const seedHost = (hostId: string, lastSeen: string) => {
      db.prepare(
        "INSERT OR REPLACE INTO hosts (host_id, first_seen, last_seen) VALUES (?, datetime('now', '-1 day'), datetime(?))"
      ).run(hostId, lastSeen);
    };

    it('triggers when a host last_seen is older than the threshold', () => {
      seedHost('proxmox-01', ts(new Date(NOW - 30 * 60 * 1000))); // 30 min ago

      const { triggered } = evaluateAlerts(db, { alerts: offlineConfig });
      const offline = triggered.filter((a: any) => a.type === 'host_offline');
      assert.equal(offline.length, 1);
      assert.equal(offline[0].hostId, 'proxmox-01');
      assert.equal(offline[0].target, 'system');
      assert.ok(offline[0].message.includes('has not reported'));
    });

    it('does NOT trigger when a host last_seen is within the threshold', () => {
      seedHost('proxmox-01', ts(new Date(NOW - 5 * 60 * 1000))); // 5 min ago — well within 15 min window

      const { triggered } = evaluateAlerts(db, { alerts: offlineConfig });
      const offline = triggered.filter((a: any) => a.type === 'host_offline');
      assert.equal(offline.length, 0);
    });

    it('does NOT trigger when alerts.hostOffline is false', () => {
      seedHost('proxmox-01', ts(new Date(NOW - 30 * 60 * 1000)));

      const disabled = { ...offlineConfig, hostOffline: false };
      const { triggered } = evaluateAlerts(db, { alerts: disabled });
      const offline = triggered.filter((a: any) => a.type === 'host_offline');
      assert.equal(offline.length, 0);
    });

    it('does NOT trigger when hostOfflineMinutes is 0 (kill switch)', () => {
      seedHost('proxmox-01', ts(new Date(NOW - 30 * 60 * 1000)));

      const zero = { ...offlineConfig, hostOfflineMinutes: 0 };
      const { triggered } = evaluateAlerts(db, { alerts: zero });
      const offline = triggered.filter((a: any) => a.type === 'host_offline');
      assert.equal(offline.length, 0);
    });

    it('fires one alert per offline host in a mixed fleet', () => {
      seedHost('alive', ts(new Date(NOW - 2 * 60 * 1000)));    // 2 min ago — online
      seedHost('grace', ts(new Date(NOW - 10 * 60 * 1000)));   // 10 min — within grace
      seedHost('offline-1', ts(new Date(NOW - 30 * 60 * 1000)));
      seedHost('offline-2', ts(new Date(NOW - 2 * 60 * 60 * 1000))); // 2 hours

      const { triggered } = evaluateAlerts(db, { alerts: offlineConfig });
      const offline = triggered.filter((a: any) => a.type === 'host_offline');
      assert.equal(offline.length, 2);
      const ids = offline.map((a: any) => a.hostId).sort();
      assert.deepEqual(ids, ['offline-1', 'offline-2']);
    });

    it('resolves when the host reports again', () => {
      // Seed a host whose last_seen is now fresh, plus a stale host_offline alert.
      seedHost('proxmox-01', ts(new Date(NOW - 2 * 60 * 1000))); // 2 min ago — fresh
      seedAlertState(db, [
        { hostId: 'proxmox-01', type: 'host_offline', target: 'system',
          triggeredAt: ts(new Date(NOW - 60 * 60 * 1000)),
          lastNotified: ts(new Date(NOW - 60 * 60 * 1000)) },
      ]);

      const { resolved } = evaluateAlerts(db, { alerts: offlineConfig });
      const offline = resolved.filter((a: any) => a.type === 'host_offline');
      assert.equal(offline.length, 1);
      assert.ok(offline[0].message.includes('back online'));
    });

    it('does NOT resolve when the host is still offline', () => {
      seedHost('proxmox-01', ts(new Date(NOW - 30 * 60 * 1000))); // still stale
      seedAlertState(db, [
        { hostId: 'proxmox-01', type: 'host_offline', target: 'system',
          triggeredAt: ts(new Date(NOW - 60 * 60 * 1000)),
          lastNotified: ts(new Date(NOW - 60 * 60 * 1000)) },
      ]);

      const { resolved } = evaluateAlerts(db, { alerts: offlineConfig });
      const offline = resolved.filter((a: any) => a.type === 'host_offline');
      assert.equal(offline.length, 0);
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

    describe('stale container auto-resolve', () => {
      // Mark a host as "still reporting" by setting last_seen to now.
      // Required for the auto-resolve path after the host-offline guard —
      // a stale container alert only resolves when the HOST itself is
      // currently reporting. Otherwise every alert on a dark agent would
      // silently disappear.
      const markHostAlive = (hostId: string = 'local') => {
        db.prepare(
          "INSERT OR REPLACE INTO hosts (host_id, first_seen, last_seen) VALUES (?, datetime('now', '-1 day'), datetime('now'))"
        ).run(hostId);
      };

      // An unhealthy container whose latest snapshot is older than the
      // 15-minute recency window counts as "gone" — pod was deleted,
      // agent stopped reporting, etc.
      it('resolves container_unhealthy when the container stops being reported', () => {
        markHostAlive();
        const longAgo = ts(new Date(NOW - 30 * 60 * 1000)); // 30 min ago
        seedContainerSnapshots(db, [
          { name: 'crashloop', status: 'created', health: 'unhealthy', at: longAgo },
        ]);
        seedAlertState(db, [
          { type: 'container_unhealthy', target: 'crashloop', triggeredAt: longAgo, lastNotified: longAgo },
        ]);

        const { resolved } = evaluateAlerts(db, { alerts: alertsConfig });
        const match = resolved.filter((a: any) => a.type === 'container_unhealthy');
        assert.equal(match.length, 1);
        assert.ok(match[0].message.includes('no longer reported'), `expected stale message, got: ${match[0].message}`);
      });

      it('resolves restart_loop when the container stops being reported', () => {
        markHostAlive();
        const longAgo = ts(new Date(NOW - 30 * 60 * 1000));
        seedContainerSnapshots(db, [
          { name: 'zombie', status: 'exited', at: longAgo },
        ]);
        seedAlertState(db, [
          { type: 'restart_loop', target: 'zombie', triggeredAt: longAgo, lastNotified: longAgo },
        ]);

        const { resolved } = evaluateAlerts(db, { alerts: alertsConfig });
        const match = resolved.filter((a: any) => a.type === 'restart_loop');
        assert.equal(match.length, 1);
      });

      it('does NOT auto-resolve when the container is still being reported', () => {
        markHostAlive();
        // Snapshot from 5 min ago — well within the 15-min window, so the
        // container is still live. The existing container_unhealthy resolver
        // should still fire (or not) based on the actual health_status.
        const fresh = ts(new Date(NOW - 5 * 60 * 1000));
        seedContainerSnapshots(db, [
          { name: 'alive', status: 'running', health: 'unhealthy', at: fresh },
        ]);
        seedAlertState(db, [
          { type: 'container_unhealthy', target: 'alive', triggeredAt: fresh, lastNotified: fresh },
        ]);

        const { resolved } = evaluateAlerts(db, { alerts: alertsConfig });
        const match = resolved.filter((a: any) => a.type === 'container_unhealthy');
        // Still unhealthy and still being reported → alert stays open.
        assert.equal(match.length, 0);
      });

      it('does NOT auto-resolve when the HOST is offline (agent went dark)', () => {
        // The whole host stopped reporting 30 min ago — mark hosts.last_seen
        // stale. A container alert on that host must NOT auto-resolve: the
        // container is still in its last-known "bad" state, and silently
        // clearing the alert would hide a real failure mode from the user.
        const longAgo = ts(new Date(NOW - 30 * 60 * 1000));
        db.prepare(
          "INSERT OR REPLACE INTO hosts (host_id, first_seen, last_seen) VALUES (?, datetime('now', '-1 day'), ?)"
        ).run('local', longAgo);

        seedContainerSnapshots(db, [
          { name: 'offline-container', status: 'running', health: 'unhealthy', at: longAgo },
        ]);
        seedAlertState(db, [
          { type: 'container_unhealthy', target: 'offline-container', triggeredAt: longAgo, lastNotified: longAgo },
        ]);

        const { resolved } = evaluateAlerts(db, { alerts: alertsConfig });
        const match = resolved.filter((a: any) => a.type === 'container_unhealthy');
        assert.equal(match.length, 0, `alert must stay active when the host is offline, got: ${JSON.stringify(match)}`);
      });

      it('does NOT auto-resolve host-scoped alerts', () => {
        // high_host_cpu is host-scoped, not container-scoped — it should
        // never get caught by the container-targeting recency check.
        // Seed no container_snapshots, no host_snapshots — the host-scoped
        // resolver will simply fail to match and the alert stays active.
        seedAlertState(db, [
          { type: 'high_host_cpu', target: 'proxmox-01', triggeredAt: ts(new Date(NOW - 3600000)), lastNotified: ts(new Date(NOW - 3600000)) },
        ]);

        const { resolved } = evaluateAlerts(db, { alerts: alertsConfig });
        assert.equal(resolved.filter((a: any) => a.type === 'high_host_cpu').length, 0);
      });
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

  describe('reminder backoff', () => {
    const backoffConfig = { alerts: { cooldownMinutes: 60, reminderBackoff: true, reminderMaxMinutes: 1440 } };

    function hoursAgo(hours: number): string {
      return ts(new Date(NOW - hours * 60 * 60 * 1000));
    }

    it('suppresses reminder #1 during base cooldown window', () => {
      seedAlertState(db, [
        { type: 'container_down', target: 'nginx', triggeredAt: hoursAgo(1), lastNotified: hoursAgo(0.5), notifyCount: 1 },
      ]);
      const triggered = [{ type: 'container_down', hostId: 'local', target: 'nginx', message: 'test' }];
      const toSend = processAlerts(db, backoffConfig, { triggered, resolved: [] });
      assert.equal(toSend.length, 0);
    });

    it('sends reminder #1 once base cooldown has elapsed', () => {
      seedAlertState(db, [
        { type: 'container_down', target: 'nginx', triggeredAt: hoursAgo(2), lastNotified: hoursAgo(1.1), notifyCount: 1 },
      ]);
      const triggered = [{ type: 'container_down', hostId: 'local', target: 'nginx', message: 'test' }];
      const toSend = processAlerts(db, backoffConfig, { triggered, resolved: [] });
      assert.equal(toSend.length, 1);
      assert.equal(toSend[0].reminderNumber, 1);
    });

    it('doubles gap before reminder #2 (suppresses after only 1h)', () => {
      // notify_count=2 means the initial send + one reminder already happened.
      // Required gap = base * 2 = 120 minutes. 61 min < 120 → suppress.
      seedAlertState(db, [
        { type: 'container_down', target: 'nginx', triggeredAt: hoursAgo(3), lastNotified: ts(new Date(NOW - 61 * 60 * 1000)), notifyCount: 2 },
      ]);
      const triggered = [{ type: 'container_down', hostId: 'local', target: 'nginx', message: 'test' }];
      const toSend = processAlerts(db, backoffConfig, { triggered, resolved: [] });
      assert.equal(toSend.length, 0);
    });

    it('sends reminder #2 once 2× base has elapsed', () => {
      seedAlertState(db, [
        { type: 'container_down', target: 'nginx', triggeredAt: hoursAgo(4), lastNotified: hoursAgo(2.1), notifyCount: 2 },
      ]);
      const triggered = [{ type: 'container_down', hostId: 'local', target: 'nginx', message: 'test' }];
      const toSend = processAlerts(db, backoffConfig, { triggered, resolved: [] });
      assert.equal(toSend.length, 1);
      assert.equal(toSend[0].reminderNumber, 2);
    });

    it('caps the gap at reminderMaxMinutes', () => {
      // notify_count=10 would request base*2^9 = 30720 minutes; cap is 1440.
      // Last notified 25h ago → should fire.
      seedAlertState(db, [
        { type: 'container_down', target: 'nginx', triggeredAt: hoursAgo(200), lastNotified: hoursAgo(25), notifyCount: 10 },
      ]);
      const triggered = [{ type: 'container_down', hostId: 'local', target: 'nginx', message: 'test' }];
      const toSend = processAlerts(db, backoffConfig, { triggered, resolved: [] });
      assert.equal(toSend.length, 1);
      assert.equal(toSend[0].reminderNumber, 10);
    });

    it('suppresses when within the cap window', () => {
      seedAlertState(db, [
        { type: 'container_down', target: 'nginx', triggeredAt: hoursAgo(200), lastNotified: hoursAgo(23), notifyCount: 10 },
      ]);
      const triggered = [{ type: 'container_down', hostId: 'local', target: 'nginx', message: 'test' }];
      const toSend = processAlerts(db, backoffConfig, { triggered, resolved: [] });
      assert.equal(toSend.length, 0);
    });

    it('falls back to flat cooldown when backoff disabled', () => {
      const flatConfig = { alerts: { cooldownMinutes: 60, reminderBackoff: false, reminderMaxMinutes: 1440 } };
      // notify_count=5 — with backoff this would require 960 minutes, but flat should require only 60.
      seedAlertState(db, [
        { type: 'container_down', target: 'nginx', triggeredAt: hoursAgo(10), lastNotified: hoursAgo(1.1), notifyCount: 5 },
      ]);
      const triggered = [{ type: 'container_down', hostId: 'local', target: 'nginx', message: 'test' }];
      const toSend = processAlerts(db, flatConfig, { triggered, resolved: [] });
      assert.equal(toSend.length, 1);
      assert.equal(toSend[0].reminderNumber, 5);
    });

    it('defaults to backoff on when flag is omitted', () => {
      // No reminderBackoff key at all — must default to true, so notify_count=5 → 960 min required.
      const defaultConfig = { alerts: { cooldownMinutes: 60 } };
      seedAlertState(db, [
        { type: 'container_down', target: 'nginx', triggeredAt: hoursAgo(10), lastNotified: hoursAgo(1.1), notifyCount: 5 },
      ]);
      const triggered = [{ type: 'container_down', hostId: 'local', target: 'nginx', message: 'test' }];
      const toSend = processAlerts(db, defaultConfig, { triggered, resolved: [] });
      assert.equal(toSend.length, 0);
    });
  });

  describe('silence', () => {
    const config = { alerts: { cooldownMinutes: 60, reminderBackoff: false } };

    function hoursFromNow(hours: number): string {
      return ts(new Date(NOW.getTime() + hours * 60 * 60 * 1000));
    }
    function hoursAgo(hours: number): string {
      return ts(new Date(NOW.getTime() - hours * 60 * 60 * 1000));
    }

    it('blocks reminder when silenced_until is in the future', () => {
      // Cooldown is 60 min and lastNotified is 2h ago — without silence this would fire.
      seedAlertState(db, [{
        type: 'container_down', target: 'nginx',
        triggeredAt: hoursAgo(3), lastNotified: hoursAgo(2),
        notifyCount: 1, silencedUntil: hoursFromNow(1),
      }]);
      const triggered = [{ type: 'container_down', hostId: 'local', target: 'nginx', message: 'test' }];
      const toSend = processAlerts(db, config, { triggered, resolved: [] });
      assert.equal(toSend.length, 0);
    });

    it('allows reminder when silenced_until is in the past (stale silence)', () => {
      seedAlertState(db, [{
        type: 'container_down', target: 'nginx',
        triggeredAt: hoursAgo(3), lastNotified: hoursAgo(2),
        notifyCount: 1, silencedUntil: hoursAgo(1),
      }]);
      const triggered = [{ type: 'container_down', hostId: 'local', target: 'nginx', message: 'test' }];
      const toSend = processAlerts(db, config, { triggered, resolved: [] });
      assert.equal(toSend.length, 1);
    });

    it('blocks reminder forever when silenced_until is the far-future sentinel', () => {
      seedAlertState(db, [{
        type: 'container_down', target: 'nginx',
        triggeredAt: hoursAgo(72), lastNotified: hoursAgo(48),
        notifyCount: 5, silencedUntil: '9999-12-31 23:59:59',
      }]);
      const triggered = [{ type: 'container_down', hostId: 'local', target: 'nginx', message: 'test' }];
      const toSend = processAlerts(db, config, { triggered, resolved: [] });
      assert.equal(toSend.length, 0);
    });

    it('does NOT affect the initial firing of a brand-new alert', () => {
      // No existing alert_state row — silence cannot apply because the row doesn't exist yet.
      const triggered = [{ type: 'container_down', hostId: 'local', target: 'nginx', message: 'test' }];
      const toSend = processAlerts(db, config, { triggered, resolved: [] });
      assert.equal(toSend.length, 1);
      assert.equal(toSend[0].reminderNumber, 0);
    });

    it('does NOT reset notify_count — backoff resumes at the same step on unsilence', () => {
      seedAlertState(db, [{
        type: 'container_down', target: 'nginx',
        triggeredAt: hoursAgo(10), lastNotified: hoursAgo(2),
        notifyCount: 4, silencedUntil: hoursFromNow(1),
      }]);
      const triggered = [{ type: 'container_down', hostId: 'local', target: 'nginx', message: 'test' }];
      processAlerts(db, config, { triggered, resolved: [] });
      // The silenced row's notify_count should be unchanged (still 4).
      const row = db.prepare('SELECT notify_count FROM alert_state WHERE target = ?').get('nginx') as { notify_count: number };
      assert.equal(row.notify_count, 4);
    });
  });
});

describe('requiredReminderGap', () => {
  let requiredReminderGap: Function;
  beforeEach(() => {
    delete require.cache[require.resolve('../../src/alerts/evaluator')];
    requiredReminderGap = require('../../src/alerts/evaluator').requiredReminderGap;
  });

  it('returns base for notifyCount=1 (first reminder)', () => {
    assert.equal(requiredReminderGap(1, 60, 1440, true), 60);
  });

  it('doubles for each successive reminder', () => {
    assert.equal(requiredReminderGap(2, 60, 1440, true), 120);
    assert.equal(requiredReminderGap(3, 60, 1440, true), 240);
    assert.equal(requiredReminderGap(4, 60, 1440, true), 480);
    assert.equal(requiredReminderGap(5, 60, 1440, true), 960);
  });

  it('caps at reminderMaxMinutes', () => {
    assert.equal(requiredReminderGap(6, 60, 1440, true), 1440);
    assert.equal(requiredReminderGap(20, 60, 1440, true), 1440);
    assert.equal(requiredReminderGap(100, 60, 1440, true), 1440);
  });

  it('returns base when backoff disabled', () => {
    assert.equal(requiredReminderGap(1, 60, 1440, false), 60);
    assert.equal(requiredReminderGap(10, 60, 1440, false), 60);
  });

  it('honours custom base and cap', () => {
    assert.equal(requiredReminderGap(1, 30, 720, true), 30);
    assert.equal(requiredReminderGap(5, 30, 720, true), 480);
    assert.equal(requiredReminderGap(6, 30, 720, true), 720);
  });
});
