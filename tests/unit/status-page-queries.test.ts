import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const {
  createTestDb,
  seedContainerSnapshots,
  seedServiceGroups,
  seedGroupMembers,
  seedHttpEndpoints,
  seedHttpChecks,
  seedAlertState,
} = require('../helpers/db');
const { ts } = require('../helpers/fixtures');
const { suppressConsole } = require('../helpers/mocks');
const { getStackHistory, getEndpointHistory, getRecentIncidents } = require('../../hub/src/web/status-page-queries');

function dayOffset(n: number): Date {
  return new Date(Date.now() - n * 86400000);
}

function todayUTC(offsetDays = 0): string {
  const d = new Date(Date.now() - offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}

describe('status-page queries', () => {
  let db: any, restore: () => void;

  beforeEach(() => {
    restore = suppressConsole();
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
    restore();
  });

  describe('getStackHistory', () => {
    it('returns 30 buckets even when no data exists', () => {
      const [gid] = seedServiceGroups(db, [{ name: 'media' }]);
      seedGroupMembers(db, [{ groupId: gid, hostId: 'h1', containerName: 'sonarr' }]);
      const hist = getStackHistory(db, gid);
      assert.equal(hist.length, 30);
      assert.ok(hist.every((d: any) => d.status === 'no_data'));
      assert.equal(hist[0].uptimePercent, null);
    });

    it('marks an all-running day as operational', () => {
      const [gid] = seedServiceGroups(db, [{ name: 'media' }]);
      seedGroupMembers(db, [{ groupId: gid, hostId: 'h1', containerName: 'sonarr' }]);
      // 10 snapshots today, all running
      for (let i = 0; i < 10; i++) {
        seedContainerSnapshots(db, [{
          hostId: 'h1', name: 'sonarr', id: 'c1',
          status: 'running', at: ts(new Date(Date.now() - i * 60000)),
        }]);
      }
      const hist = getStackHistory(db, gid);
      const today = hist[hist.length - 1];
      assert.equal(today.status, 'operational');
      assert.equal(today.uptimePercent, 100);
    });

    it('marks a day with <90% uptime as outage', () => {
      const [gid] = seedServiceGroups(db, [{ name: 'media' }]);
      seedGroupMembers(db, [{ groupId: gid, hostId: 'h1', containerName: 'sonarr' }]);
      const at = ts(new Date(Date.now() - 60000));
      // 8 snapshots: 3 running, 5 exited — 37.5% uptime (outage)
      for (let i = 0; i < 3; i++) {
        seedContainerSnapshots(db, [{ hostId: 'h1', name: 'sonarr', id: 'c1', status: 'running', at }]);
      }
      for (let i = 0; i < 5; i++) {
        seedContainerSnapshots(db, [{ hostId: 'h1', name: 'sonarr', id: 'c1', status: 'exited', at }]);
      }
      const hist = getStackHistory(db, gid);
      const today = hist[hist.length - 1];
      assert.equal(today.status, 'outage');
      assert.ok(today.uptimePercent! < 50);
    });

    it('bridges raw snapshots and hourly rollups for the same stack', () => {
      const [gid] = seedServiceGroups(db, [{ name: 'media' }]);
      seedGroupMembers(db, [{ groupId: gid, hostId: 'h1', containerName: 'sonarr' }]);

      // Recent: raw snapshot
      seedContainerSnapshots(db, [{
        hostId: 'h1', name: 'sonarr', id: 'c1',
        status: 'running', at: ts(new Date(Date.now() - 60000)),
      }]);

      // 20 days ago: a rollup with 60 up / 60 total
      const oldBucket = dayOffset(20).toISOString().slice(0, 13) + ':00:00';
      db.prepare(`INSERT INTO container_rollups
        (host_id, container_name, bucket, status_running, status_total, sample_count)
        VALUES (?, ?, ?, ?, ?, ?)`).run('h1', 'sonarr', oldBucket, 60, 60, 60);

      const hist = getStackHistory(db, gid);
      const oldDay = hist.find((d: any) => d.date === todayUTC(20));
      assert.ok(oldDay);
      assert.equal(oldDay!.status, 'operational');
      assert.equal(oldDay!.uptimePercent, 100);
    });
  });

  describe('getEndpointHistory', () => {
    it('computes daily uptime from http_checks', () => {
      const [epId] = seedHttpEndpoints(db, [{ name: 'api', url: 'https://x' }]);
      const at = ts(new Date(Date.now() - 60000));
      for (let i = 0; i < 9; i++) seedHttpChecks(db, [{ endpointId: epId, isUp: true, at }]);
      seedHttpChecks(db, [{ endpointId: epId, isUp: false, at }]);
      const hist = getEndpointHistory(db, epId);
      const today = hist[hist.length - 1];
      assert.equal(today.uptimePercent, 90);
      assert.equal(today.status, 'degraded');
    });

    it('merges http_rollups from older days', () => {
      const [epId] = seedHttpEndpoints(db, [{ name: 'api', url: 'https://x' }]);
      const oldBucket = dayOffset(10).toISOString().slice(0, 13) + ':00:00';
      db.prepare(`INSERT INTO http_rollups
        (endpoint_id, bucket, up_count, total_count, sample_count)
        VALUES (?, ?, ?, ?, ?)`).run(epId, oldBucket, 100, 100, 100);
      const hist = getEndpointHistory(db, epId);
      const d = hist.find((x: any) => x.date === todayUTC(10));
      assert.ok(d);
      assert.equal(d!.status, 'operational');
    });
  });

  describe('getRecentIncidents', () => {
    it('returns only resolved alerts within the window, newest first', () => {
      seedAlertState(db, [
        { type: 'container_down', target: 'a', triggeredAt: ts(dayOffset(2)), resolvedAt: ts(dayOffset(1)) },
        { type: 'endpoint_down', target: 'b', triggeredAt: ts(dayOffset(5)), resolvedAt: ts(dayOffset(4)) },
        { type: 'high_cpu', target: 'still-going', triggeredAt: ts(dayOffset(1)), resolvedAt: null },
        { type: 'old_alert', target: 'c', triggeredAt: ts(dayOffset(60)), resolvedAt: ts(dayOffset(59)) },
      ]);
      const list = getRecentIncidents(db);
      assert.equal(list.length, 2);
      assert.equal(list[0].target, 'a'); // most recent resolution
      assert.equal(list[1].target, 'b');
      // durationMinutes is roughly one day.
      assert.ok(list[0].durationMinutes >= 60 * 23);
    });

    it('honors the limit parameter', () => {
      const rows: any[] = [];
      for (let i = 0; i < 30; i++) {
        rows.push({ type: 'container_down', target: `t${i}`,
          triggeredAt: ts(dayOffset(2)), resolvedAt: ts(dayOffset(1)) });
      }
      seedAlertState(db, rows);
      const list = getRecentIncidents(db, 5);
      assert.equal(list.length, 5);
    });
  });
});
