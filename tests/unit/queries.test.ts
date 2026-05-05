import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const { createTestDb, seedContainerSnapshots, seedDiskSnapshots, seedUpdateChecks, seedAlertState } = require('../helpers/db');
const { ts, NOW } = require('../helpers/fixtures');
const { getHealth, getHosts, getHostDetail, getLatestContainers, getLatestDisk, getLatestUpdates, getAlerts, getDashboard, getContainerHistory, getContainerAlerts, getContainerDowntime, getHostRuntimeType } = require('../../hub/src/web/queries');

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
      assert.equal(health.schemaVersion, 48);
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
      seedHost(db, 'h1', recent);
      seedContainerSnapshots(db, [
        { hostId: 'h1', name: 'nginx', status: 'running', cpu: 5, mem: 50, at: old },
        { hostId: 'h1', name: 'nginx', status: 'running', cpu: 10, mem: 60, at: recent },
        { hostId: 'h1', name: 'redis', status: 'exited', cpu: null, mem: null, at: recent },
      ]);

      const containers = getLatestContainers(db, 'h1', 10);
      assert.equal(containers.length, 2);

      const nginx = containers.find((c: any) => c.container_name === 'nginx');
      assert.equal(nginx.cpu_percent, 10);
      assert.equal(nginx.memory_mb, 60);
      assert.equal(nginx.is_stale, 0);

      const redis = containers.find((c: any) => c.container_name === 'redis');
      assert.equal(redis.status, 'exited');
      assert.equal(redis.is_stale, 0);
    });

    it('returns empty for unknown host', () => {
      const containers = getLatestContainers(db, 'unknown', 10);
      assert.deepEqual(containers, []);
    });

    it('flags containers as stale when host last_seen exceeds threshold', () => {
      seedHost(db, 'h1', stale); // 2 hours ago, well past 15 min threshold
      seedContainerSnapshots(db, [
        { hostId: 'h1', name: 'nginx', status: 'running', cpu: 5, mem: 50, at: stale },
      ]);

      const containers = getLatestContainers(db, 'h1', 15);
      assert.equal(containers.length, 1);
      assert.equal(containers[0].is_stale, 1, 'container on offline host should be stale');
      assert.equal(containers[0].status, 'running', 'last-known status preserved');
    });

    it('does not flag containers as stale when host is within threshold', () => {
      seedHost(db, 'h1', recent);
      seedContainerSnapshots(db, [
        { hostId: 'h1', name: 'nginx', status: 'running', cpu: 5, mem: 50, at: recent },
      ]);

      const containers = getLatestContainers(db, 'h1', 15);
      assert.equal(containers[0].is_stale, 0);
    });

    it('exposes exit_code so completed oneshots can be distinguished from failures', () => {
      seedHost(db, 'h1', recent);
      seedContainerSnapshots(db, [
        { hostId: 'h1', name: 'bootstrap', status: 'exited', exitCode: 0, at: recent },
        { hostId: 'h1', name: 'crasher', status: 'exited', exitCode: 137, at: recent },
      ]);

      const containers = getLatestContainers(db, 'h1', 15);
      const bootstrap = containers.find((c: any) => c.container_name === 'bootstrap');
      const crasher = containers.find((c: any) => c.container_name === 'crasher');
      assert.equal(bootstrap.exit_code, 0);
      assert.equal(crasher.exit_code, 137);
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

  describe('getHostRuntimeType', () => {
    it('defaults to "docker" when host does not exist', () => {
      assert.equal(getHostRuntimeType(db, 'unknown'), 'docker');
    });

    it('defaults to "docker" for hosts inserted without a runtime_type', () => {
      // seedHost uses bare INSERT; schema default is 'docker'
      seedHost(db, 'legacy-host', recent);
      assert.equal(getHostRuntimeType(db, 'legacy-host'), 'docker');
    });

    it('returns "kubernetes" when the host is a k8s node', () => {
      db.prepare('INSERT INTO hosts (host_id, first_seen, last_seen, runtime_type) VALUES (?, datetime(?), datetime(?), ?)')
        .run('k3d-node-1', recent, recent, 'kubernetes');
      assert.equal(getHostRuntimeType(db, 'k3d-node-1'), 'kubernetes');
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

    it('classifies clean exit-0 one-shots as completed, not down', () => {
      seedHost(db, 'h1', recent);
      seedContainerSnapshots(db, [
        { hostId: 'h1', name: 'nginx', status: 'running', at: recent },
        // Successful init container — exited 0. Not a failure.
        { hostId: 'h1', name: 'insightd-bootstrap', status: 'exited', exitCode: 0, at: recent },
        // Crashed container — exited non-zero. Real failure.
        { hostId: 'h1', name: 'broken-app', status: 'exited', exitCode: 137, at: recent },
      ]);

      const dash = getDashboard(db, 10);
      assert.equal(dash.totalContainers, 3);
      assert.equal(dash.containersRunning, 1);
      assert.equal(dash.containersCompleted, 1, 'bootstrap should be classified as completed');
      assert.equal(dash.containersDown, 1, 'only the non-zero exit counts as down');
    });

    it('patches stale alerts factor with live count in systemHealthScore', () => {
      // Seed a host with a stale health_scores row claiming 2 active alerts
      // (alerts.value=2, alerts.score=60) and only 1 live active alert in
      // alert_state. The dashboard should return the live count and a
      // recomputed host score, not the stale ones.
      seedHost(db, 'h1', recent);
      seedContainerSnapshots(db, [
        { hostId: 'h1', name: 'nginx', status: 'running', at: recent },
      ]);
      db.prepare(`
        INSERT INTO health_scores (entity_type, entity_id, score, factors, computed_at)
        VALUES ('host', 'h1', 85,
          '{"cpu":{"score":100,"weight":20,"value":20,"rating":"normal"},"memory":{"score":100,"weight":20,"value":30,"rating":"normal"},"load":{"score":100,"weight":15,"value":1,"rating":"normal"},"online":{"score":100,"weight":20,"value":1,"rating":"normal"},"alerts":{"score":60,"weight":15,"value":2,"rating":"elevated"}}',
          datetime('now', '-2 hours'))
      `).run();
      db.prepare(`
        INSERT INTO health_scores (entity_type, entity_id, score, factors, computed_at)
        VALUES ('system', 'system', 85, '{"hostCount":1,"hostScores":[85]}', datetime('now', '-2 hours'))
      `).run();
      // Only ONE active alert for h1 — the other was resolved mid-hour.
      seedAlertState(db, [
        { hostId: 'h1', type: 'container_down', target: 'nginx', triggeredAt: recent },
        { hostId: 'h1', type: 'high_cpu', target: 'nginx', triggeredAt: old, resolvedAt: recent },
      ]);

      const dash = getDashboard(db, 10);
      const hs = dash.systemHealthScore;
      assert.ok(hs, 'expected systemHealthScore');
      assert.equal(hs.hostBreakdown.length, 1);

      const h1 = hs.hostBreakdown[0];
      assert.equal(h1.hostId, 'h1');
      // alerts factor should reflect the 1 live active alert, not the stale 2
      assert.equal(h1.factors.alerts.value, 1);
      assert.equal(h1.factors.alerts.score, 80);
      assert.equal(h1.factors.alerts.rating, 'elevated');

      // Host score should be recomputed from the patched factors:
      // (100*20 + 100*20 + 100*15 + 100*20 + 80*15) / 90 = 8700/90 ≈ 96.67 → 97
      assert.equal(h1.score, 97);

      // System score recomputed from the updated host scores
      assert.equal(hs.score, 97);
    });

    it('overallPercent excludes intentionally-stopped containers', () => {
      // Simulates proxmox-01 with nginx sitting 'exited' for days — the agent
      // still reports it every 5 min (docker ps -a). getDashboard previously
      // exposed a per-container `downContainers` list that the frontend
      // routed into the acute "Needs Attention" feed, which duplicated the
      // retrospective `had downtime` insight. That list is gone; what
      // remains is the fleet-wide `overallPercent`, which should still
      // ignore intentionally-stopped containers by design (the upstream
      // filter in getDashboard skips any container whose latest snapshot
      // is not 'running').
      seedHost(db, 'h1', recent);
      const snapshots: any[] = [];
      for (let i = 0; i < 20; i++) {
        const minutesAgo = 5 + i * 5;
        snapshots.push({ hostId: 'h1', name: 'nginx', status: 'exited', at: ts(new Date(NOW - minutesAgo * 60 * 1000)) });
      }
      // A currently-running container with 100% uptime — the fleet % should
      // be 100 and nginx should not drag it down.
      for (let i = 0; i < 12; i++) {
        snapshots.push({ hostId: 'h1', name: 'webapp', status: 'running', at: ts(new Date(NOW - (5 + i * 5) * 60 * 1000)) });
      }
      seedContainerSnapshots(db, snapshots);

      const dash = getDashboard(db, 10);
      assert.equal(dash.availability.overallPercent, 100,
        'exited nginx must not drag overallPercent below 100');
      assert.equal(dash.availability.downContainers, undefined,
        'downContainers field removed — retrospective dips live in topInsights now');
    });

    it('leaves alerts factor alone when live count matches stored value', () => {
      seedHost(db, 'h1', recent);
      seedContainerSnapshots(db, [{ hostId: 'h1', name: 'nginx', status: 'running', at: recent }]);
      db.prepare(`
        INSERT INTO health_scores (entity_type, entity_id, score, factors, computed_at)
        VALUES ('host', 'h1', 80,
          '{"cpu":{"score":100,"weight":20,"value":20,"rating":"normal"},"alerts":{"score":80,"weight":15,"value":1,"rating":"elevated"}}',
          datetime('now'))
      `).run();
      db.prepare(`
        INSERT INTO health_scores (entity_type, entity_id, score, factors, computed_at)
        VALUES ('system', 'system', 80, '{"hostCount":1,"hostScores":[80]}', datetime('now'))
      `).run();
      seedAlertState(db, [
        { hostId: 'h1', type: 'container_down', target: 'nginx', triggeredAt: recent },
      ]);

      const dash = getDashboard(db, 10);
      const h1 = dash.systemHealthScore.hostBreakdown[0];
      assert.equal(h1.factors.alerts.value, 1);
      // Score stays at stored value since nothing was patched
      assert.equal(h1.score, 80);
      assert.equal(dash.systemHealthScore.score, 80);
    });

    it('getTopInsights returns the evidence column so the frontend can render timeAgo', () => {
      seedHost(db, 'h1', recent);
      seedContainerSnapshots(db, [{ hostId: 'h1', name: 'nginx', status: 'running', at: recent }]);
      db.prepare(`
        INSERT INTO insights (entity_type, entity_id, category, severity, title, message, metric, current_value, baseline_value, evidence)
        VALUES ('container', 'h1/nginx', 'availability', 'warning',
                'nginx recovered from a brief dip',
                'Down for ~5m in the last 24h — now running again (98.9% uptime).',
                null, 98.9, 99,
                '{"lastDownAt":"2026-04-15 16:32:07","downMinutes":5,"uptimePct":98.9}')
      `).run();

      const dash = getDashboard(db, 10);
      const insight = dash.topInsights.find((i: any) => i.title.includes('recovered'));
      assert.ok(insight, 'expected the availability insight to surface in topInsights');
      assert.ok(insight.evidence, 'evidence field must be returned');
      const ev = JSON.parse(insight.evidence);
      assert.equal(ev.lastDownAt, '2026-04-15 16:32:07');
      assert.equal(ev.downMinutes, 5);
      assert.equal(ev.uptimePct, 98.9);
    });

    it('returns recent activity sorted newest-first across alert fires/resolves and insights', () => {
      seedHost(db, 'h1', recent);

      // Alert fired ~2h ago, resolved 30m later. Both events should surface.
      // Use relative timestamps — the query has a 24h cutoff, so hardcoded
      // dates become stale when the test date rolls forward.
      const firedAt = ts(new Date(Date.now() - 2 * 60 * 60 * 1000));
      const resolvedAt = ts(new Date(Date.now() - 90 * 60 * 1000));
      seedAlertState(db, [
        { hostId: 'h1', type: 'container_down', target: 'nginx', triggeredAt: firedAt, resolvedAt },
      ]);

      // Two insights, one fresh (4h ago) and one stale (>24h ago) — only the
      // fresh one should appear.
      db.prepare(`
        INSERT INTO insights (entity_type, entity_id, category, severity, title, message, computed_at)
        VALUES
          ('container', 'h1/nginx', 'health', 'warning', 'Memory trending up', 'msg', datetime('now', '-4 hours')),
          ('host',      'h1',       'trend',  'info',    'Old insight',         'msg', datetime('now', '-2 days'))
      `).run();

      const dash = getDashboard(db, 10);
      assert.ok(Array.isArray(dash.recentActivity), 'recentActivity must be an array');

      const types = dash.recentActivity.map((r: any) => r.type);
      assert.ok(types.includes('alert_triggered'), 'expected alert_triggered in feed');
      assert.ok(types.includes('alert_resolved'), 'expected alert_resolved in feed');
      assert.ok(types.includes('insight'), 'expected insight in feed');
      assert.ok(!dash.recentActivity.some((r: any) => r.message.includes('Old insight')), 'stale (>24h) insight must be filtered out');

      // Sorted newest-first
      for (let i = 1; i < dash.recentActivity.length; i++) {
        assert.ok(dash.recentActivity[i - 1].time >= dash.recentActivity[i].time, 'recentActivity must be sorted DESC');
      }
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

    it('marks clean exit-0 hours as completed (not down) and excludes them from uptime%', () => {
      // Single snapshot of a one-shot init container that exited cleanly.
      seedContainerSnapshots(db, [
        { hostId: 'h1', name: 'insightd-bootstrap', status: 'exited', exitCode: 0, at: recent },
      ]);

      const result = getContainerDowntime(db, 'h1', 'insightd-bootstrap', 7);
      assert.ok(result.timeline.slots.includes('completed'), 'should produce a completed slot');
      assert.ok(!result.timeline.slots.includes('down'), 'should not paint a down slot for a clean exit');
      assert.equal(result.summary.downHours, 0);
      assert.equal(result.summary.completedHours, 1);
      assert.equal(result.incidents.length, 0, 'a clean exit is not an incident');
      // No actual uptime data → null %, not "0% downtime".
      assert.equal(result.summary.uptimePercent, null);
    });

    it('non-zero exits stay classified as down', () => {
      seedContainerSnapshots(db, [
        { hostId: 'h1', name: 'broken', status: 'exited', exitCode: 137, at: recent },
      ]);
      const result = getContainerDowntime(db, 'h1', 'broken', 7);
      assert.ok(result.timeline.slots.includes('down'));
      assert.ok(!result.timeline.slots.includes('completed'));
      assert.equal(result.summary.completedHours, 0);
    });
  });
});
