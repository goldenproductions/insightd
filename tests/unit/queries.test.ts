import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const { createTestDb, seedContainerSnapshots, seedDiskSnapshots, seedUpdateChecks, seedAlertState } = require('../helpers/db');
const { ts, NOW } = require('../helpers/fixtures');
const { getHealth, getHosts, getHostDetail, getLatestContainers, getLatestDisk, getLatestUpdates, getAlerts, getDashboard, getContainerHistory, getContainerAlerts, getContainerDowntime } = require('../../hub/src/web/queries');

const recent = ts(new Date(NOW - 2 * 60 * 1000)); // 2 min ago
const old = ts(new Date(NOW - 30 * 60 * 1000)); // 30 min ago
const stale = ts(new Date(NOW - 120 * 60 * 1000)); // 2 hours ago

function seedHost(db: any, hostId: string, lastSeen: string) {
  db.prepare('INSERT OR REPLACE INTO hosts (host_id, first_seen, last_seen) VALUES (?, datetime(?), datetime(?))').run(hostId, lastSeen, lastSeen);
}

describe('queries', () => {
  let db: any;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  describe('getHealth', () => {
    it('returns status ok with schema version', () => {
      const health = getHealth(db);
      assert.equal(health.status, 'ok');
      assert.equal(health.schemaVersion, 21);
      assert.equal(typeof health.uptime, 'number');
    });
  });

  describe('getHosts', () => {
    it('returns empty array when no hosts', () => {
      const hosts = getHosts(db, 10);
      assert.deepEqual(hosts, []);
    });

    it('returns hosts with online status', () => {
      seedHost(db, 'server1', recent);
      seedHost(db, 'server2', stale);

      const hosts = getHosts(db, 10);
      assert.equal(hosts.length, 2);
      assert.equal(hosts[0].host_id, 'server1');
      assert.equal(hosts[0].is_online, 1);
      assert.equal(hosts[1].host_id, 'server2');
      assert.equal(hosts[1].is_online, 0);
    });
  });

  describe('getLatestContainers', () => {
    it('returns latest snapshot per container', () => {
      seedContainerSnapshots(db, [
        { hostId: 'h1', name: 'nginx', status: 'running', cpu: 5, mem: 50, at: old },
        { hostId: 'h1', name: 'nginx', status: 'running', cpu: 10, mem: 60, at: recent },
        { hostId: 'h1', name: 'redis', status: 'exited', cpu: null, mem: null, at: recent },
      ]);

      const containers = getLatestContainers(db, 'h1');
      assert.equal(containers.length, 2);

      const nginx = containers.find((c: any) => c.container_name === 'nginx');
      assert.equal(nginx.cpu_percent, 10);
      assert.equal(nginx.memory_mb, 60);

      const redis = containers.find((c: any) => c.container_name === 'redis');
      assert.equal(redis.status, 'exited');
    });

    it('returns empty for unknown host', () => {
      const containers = getLatestContainers(db, 'unknown');
      assert.deepEqual(containers, []);
    });
  });

  describe('getLatestDisk', () => {
    it('returns latest disk snapshot for host', () => {
      seedDiskSnapshots(db, [
        { hostId: 'h1', mount: '/', total: 100, used: 40, percent: 40, at: old },
        { hostId: 'h1', mount: '/', total: 100, used: 50, percent: 50, at: recent },
        { hostId: 'h1', mount: '/data', total: 200, used: 100, percent: 50, at: recent },
      ]);

      const disk = getLatestDisk(db, 'h1');
      assert.equal(disk.length, 2);
      assert.equal(disk[0].mount_point, '/');
      assert.equal(disk[0].used_percent, 50);
    });
  });

  describe('getLatestUpdates', () => {
    it('returns only containers with available updates', () => {
      seedUpdateChecks(db, [
        { hostId: 'h1', name: 'nginx', hasUpdate: 1, at: recent },
        { hostId: 'h1', name: 'redis', hasUpdate: 0, at: recent },
      ]);

      const updates = getLatestUpdates(db, 'h1');
      assert.equal(updates.length, 1);
      assert.equal(updates[0].container_name, 'nginx');
    });

    it('returns empty when no updates available', () => {
      seedUpdateChecks(db, [
        { hostId: 'h1', name: 'nginx', hasUpdate: 0, at: recent },
      ]);

      const updates = getLatestUpdates(db, 'h1');
      assert.deepEqual(updates, []);
    });
  });

  describe('getAlerts', () => {
    it('returns only active alerts when activeOnly is true', () => {
      seedAlertState(db, [
        { hostId: 'h1', type: 'container_down', target: 'nginx', triggeredAt: recent, resolvedAt: null },
        { hostId: 'h1', type: 'high_cpu', target: 'redis', triggeredAt: old, resolvedAt: recent },
      ]);

      const active = getAlerts(db, true);
      assert.equal(active.length, 1);
      assert.equal(active[0].target, 'nginx');
    });

    it('returns all alerts when activeOnly is false', () => {
      seedAlertState(db, [
        { hostId: 'h1', type: 'container_down', target: 'nginx', triggeredAt: recent, resolvedAt: null },
        { hostId: 'h1', type: 'high_cpu', target: 'redis', triggeredAt: old, resolvedAt: recent },
      ]);

      const all = getAlerts(db, false);
      assert.equal(all.length, 2);
    });

    it('filters by hostId', () => {
      seedAlertState(db, [
        { hostId: 'h1', type: 'container_down', target: 'nginx', triggeredAt: recent },
        { hostId: 'h2', type: 'high_cpu', target: 'redis', triggeredAt: recent },
      ]);

      const h1Alerts = getAlerts(db, false, 'h1');
      assert.equal(h1Alerts.length, 1);
      assert.equal(h1Alerts[0].host_id, 'h1');
    });
  });

  describe('getHostDetail', () => {
    it('returns null for unknown host', () => {
      const detail = getHostDetail(db, 'unknown', 10);
      assert.equal(detail, null);
    });

    it('returns host with containers, disk, alerts, and updates', () => {
      seedHost(db, 'h1', recent);
      seedContainerSnapshots(db, [
        { hostId: 'h1', name: 'nginx', status: 'running', cpu: 5, mem: 50, at: recent },
      ]);
      seedDiskSnapshots(db, [
        { hostId: 'h1', mount: '/', percent: 60, at: recent },
      ]);
      seedAlertState(db, [
        { hostId: 'h1', type: 'high_cpu', target: 'nginx', triggeredAt: recent },
      ]);
      seedUpdateChecks(db, [
        { hostId: 'h1', name: 'nginx', hasUpdate: 1, at: recent },
      ]);

      const detail = getHostDetail(db, 'h1', 10);
      assert.equal(detail.host_id, 'h1');
      assert.equal(detail.is_online, 1);
      assert.equal(detail.containers.length, 1);
      assert.equal(detail.disk.length, 1);
      assert.equal(detail.alerts.length, 1);
      assert.equal(detail.updates.length, 1);
    });
  });

  describe('getDashboard', () => {
    it('returns zeros when database is empty', () => {
      const dash = getDashboard(db, 10);
      assert.equal(dash.hostCount, 0);
      assert.equal(dash.totalContainers, 0);
      assert.equal(dash.activeAlerts, 0);
    });

    it('aggregates across multiple hosts', () => {
      seedHost(db, 'h1', recent);
      seedHost(db, 'h2', stale);

      seedContainerSnapshots(db, [
        { hostId: 'h1', name: 'nginx', status: 'running', at: recent },
        { hostId: 'h1', name: 'redis', status: 'running', at: recent },
        { hostId: 'h2', name: 'postgres', status: 'exited', at: recent },
      ]);

      seedDiskSnapshots(db, [
        { hostId: 'h1', mount: '/', percent: 90, at: recent },
      ]);

      seedAlertState(db, [
        { hostId: 'h1', type: 'container_down', target: 'test', triggeredAt: recent },
        { hostId: 'h2', type: 'high_cpu', target: 'pg', triggeredAt: old, resolvedAt: recent },
      ]);

      const dash = getDashboard(db, 10);
      assert.equal(dash.hostCount, 2);
      assert.equal(dash.hostsOnline, 1);
      assert.equal(dash.hostsOffline, 1);
      assert.equal(dash.totalContainers, 3);
      assert.equal(dash.containersRunning, 2);
      assert.equal(dash.containersDown, 1);
      assert.equal(dash.activeAlerts, 1);
      assert.equal(dash.diskWarnings, 1);
    });
  });

  describe('getContainerHistory', () => {
    it('returns snapshots within the time window', () => {
      seedContainerSnapshots(db, [
        { hostId: 'h1', name: 'nginx', status: 'running', cpu: 5, mem: 50, at: recent },
        { hostId: 'h1', name: 'nginx', status: 'running', cpu: 10, mem: 60, at: old },
      ]);

      const history = getContainerHistory(db, 'h1', 'nginx', 24);
      assert.equal(history.length, 2);
      // Oldest first
      assert.ok(history[0].collected_at <= history[1].collected_at);
    });

    it('filters by container name', () => {
      seedContainerSnapshots(db, [
        { hostId: 'h1', name: 'nginx', status: 'running', at: recent },
        { hostId: 'h1', name: 'redis', status: 'running', at: recent },
      ]);

      const history = getContainerHistory(db, 'h1', 'nginx', 24);
      assert.equal(history.length, 1);
    });

    it('returns empty for unknown container', () => {
      const history = getContainerHistory(db, 'h1', 'unknown', 24);
      assert.deepEqual(history, []);
    });
  });

  describe('getContainerAlerts', () => {
    it('returns alerts for a specific container', () => {
      seedAlertState(db, [
        { hostId: 'h1', type: 'high_cpu', target: 'nginx', triggeredAt: recent },
        { hostId: 'h1', type: 'container_down', target: 'redis', triggeredAt: recent },
      ]);

      const alerts = getContainerAlerts(db, 'h1', 'nginx');
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0].alert_type, 'high_cpu');
    });

    it('returns empty for container with no alerts', () => {
      const alerts = getContainerAlerts(db, 'h1', 'nginx');
      assert.deepEqual(alerts, []);
    });
  });

  describe('getContainerDowntime', () => {
    it('returns empty incidents when container is always running', () => {
      const sixHoursAgo = ts(new Date(NOW - 6 * 60 * 60 * 1000));
      const threeHoursAgo = ts(new Date(NOW - 3 * 60 * 60 * 1000));
      seedContainerSnapshots(db, [
        { hostId: 'h1', name: 'nginx', status: 'running', at: sixHoursAgo },
        { hostId: 'h1', name: 'nginx', status: 'running', at: threeHoursAgo },
        { hostId: 'h1', name: 'nginx', status: 'running', at: recent },
      ]);

      const result = getContainerDowntime(db, 'h1', 'nginx', 7);
      assert.deepEqual(result.incidents, []);
      assert.equal(result.summary.downHours, 0);
      assert.equal(result.summary.totalHours, 168);
      assert.equal(result.timeline.slots.length, 168);
    });

    it('detects a downtime incident with correct duration', () => {
      const sixHoursAgo = ts(new Date(NOW - 6 * 60 * 60 * 1000));
      const fourHoursAgo = ts(new Date(NOW - 4 * 60 * 60 * 1000));
      const twoHoursAgo = ts(new Date(NOW - 2 * 60 * 60 * 1000));
      seedContainerSnapshots(db, [
        { hostId: 'h1', name: 'nginx', status: 'running', at: sixHoursAgo },
        { hostId: 'h1', name: 'nginx', status: 'exited', at: fourHoursAgo },
        { hostId: 'h1', name: 'nginx', status: 'running', at: twoHoursAgo },
      ]);

      const result = getContainerDowntime(db, 'h1', 'nginx', 7);
      assert.equal(result.incidents.length, 1);
      assert.equal(result.incidents[0].ongoing, false);
      assert.ok(result.incidents[0].end != null);
      assert.ok(result.incidents[0].durationMs > 0);
    });

    it('detects ongoing downtime when container is still down', () => {
      const sixHoursAgo = ts(new Date(NOW - 6 * 60 * 60 * 1000));
      const twoHoursAgo = ts(new Date(NOW - 2 * 60 * 60 * 1000));
      seedContainerSnapshots(db, [
        { hostId: 'h1', name: 'nginx', status: 'running', at: sixHoursAgo },
        { hostId: 'h1', name: 'nginx', status: 'exited', at: twoHoursAgo },
      ]);

      const result = getContainerDowntime(db, 'h1', 'nginx', 7);
      assert.equal(result.incidents.length, 1);
      assert.equal(result.incidents[0].ongoing, true);
      assert.equal(result.incidents[0].end, null);
    });

    it('returns correct timeline slot count', () => {
      seedContainerSnapshots(db, [
        { hostId: 'h1', name: 'nginx', status: 'running', at: recent },
      ]);

      const result = getContainerDowntime(db, 'h1', 'nginx', 7);
      assert.equal(result.timeline.slots.length, 168); // 7 * 24
      assert.equal(typeof result.timeline.slotStartTime, 'number');
      assert.ok(result.timeline.slotStartTime > 0);
    });
  });
});
