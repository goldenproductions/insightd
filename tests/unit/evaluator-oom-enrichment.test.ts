import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
const { createTestDb, seedContainerSnapshots } = require('../helpers/db');
const { ts, NOW } = require('../helpers/fixtures');
const { suppressConsole } = require('../helpers/mocks');

const nodemailer = require('nodemailer');

describe('evaluateAlerts — OOMKilled enrichment (hub, v40)', () => {
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
  });

  afterEach(() => {
    db.close();
    restore();
    mock.restoreAll();
  });

  const cfg = {
    enabled: true, to: 't@t.com', cooldownMinutes: 60,
    containerDown: true, restartCount: 3,
    cpuPercent: 0, memoryMb: 0, diskPercent: 0,
    hostCpuPercent: 0, hostMemoryAvailableMb: 0, hostLoadThreshold: 0,
    hostOffline: false, hostOfflineMinutes: 0,
    containerUnhealthy: true, excludeContainers: '',
    endpointDown: false, endpointFailureThreshold: 3,
    containerMemoryLimitPercent: 0,
    containerCpuLimitPercent: 0,
  };

  function setOom(containerName: string, lastOomKilledAt: string | null, atIso: string): void {
    db.prepare(`
      UPDATE container_snapshots
      SET last_oom_killed_at = ?
      WHERE container_name = ? AND collected_at = ?
    `).run(lastOomKilledAt, containerName, atIso);
  }

  describe('restart_loop enrichment', () => {
    it('appends OOM cause when last_oom_killed_at is within 30 minutes', () => {
      // Seed two snapshots 31 minutes apart with restart counts 0 → 5,
      // so checkRestartLoop's "older >= 30min" lookup finds the baseline.
      const t0 = ts(new Date(NOW - 31 * 60_000));
      const t1 = ts(NOW);
      seedContainerSnapshots(db, [
        { name: 'memhog', status: 'running', restarts: 0, at: t0 },
        { name: 'memhog', status: 'running', restarts: 5, at: t1 },
      ]);
      // Stamp the OOM 5 minutes ago — well within the 30-min window.
      const oomAt = new Date(NOW - 5 * 60_000).toISOString();
      setOom('memhog', oomAt, t1);

      const { triggered } = evaluateAlerts(db, { alerts: cfg });
      const restart = triggered.find((a: any) => a.type === 'restart_loop' && a.target === 'memhog');
      assert.ok(restart, 'restart_loop alert should fire');
      assert.match(restart.message, /killed by OOM/i, 'message should mention OOM');
    });

    it('does not append OOM cause when last_oom_killed_at is older than 30 minutes', () => {
      const t0 = ts(new Date(NOW - 31 * 60_000));
      const t1 = ts(NOW);
      seedContainerSnapshots(db, [
        { name: 'memhog', status: 'running', restarts: 0, at: t0 },
        { name: 'memhog', status: 'running', restarts: 5, at: t1 },
      ]);
      const oomAt = new Date(NOW - 90 * 60_000).toISOString();  // 90 minutes ago
      setOom('memhog', oomAt, t1);

      const { triggered } = evaluateAlerts(db, { alerts: cfg });
      const restart = triggered.find((a: any) => a.type === 'restart_loop' && a.target === 'memhog');
      assert.ok(restart);
      assert.doesNotMatch(restart.message, /killed by OOM/i);
    });

    it('leaves message unchanged when last_oom_killed_at is null', () => {
      const t0 = ts(new Date(NOW - 31 * 60_000));
      const t1 = ts(NOW);
      seedContainerSnapshots(db, [
        { name: 'flaky', status: 'running', restarts: 0, at: t0 },
        { name: 'flaky', status: 'running', restarts: 5, at: t1 },
      ]);
      // No OOM stamp.

      const { triggered } = evaluateAlerts(db, { alerts: cfg });
      const restart = triggered.find((a: any) => a.type === 'restart_loop' && a.target === 'flaky');
      assert.ok(restart);
      assert.doesNotMatch(restart.message, /OOM/i);
    });
  });

  describe('container_unhealthy enrichment', () => {
    it('appends OOM cause when last_oom_killed_at is recent', () => {
      const t1 = ts(NOW);
      seedContainerSnapshots(db, [
        { name: 'sick', status: 'running', health: 'unhealthy', at: t1 },
      ]);
      const oomAt = new Date(NOW - 2 * 60_000).toISOString();
      setOom('sick', oomAt, t1);

      const { triggered } = evaluateAlerts(db, { alerts: cfg });
      const unhealthy = triggered.find((a: any) => a.type === 'container_unhealthy' && a.target === 'sick');
      assert.ok(unhealthy, 'container_unhealthy alert should fire');
      assert.match(unhealthy.message, /killed by OOM/i);
    });

    it('does not append OOM cause when there is no OOM signal', () => {
      const t1 = ts(NOW);
      seedContainerSnapshots(db, [
        { name: 'plain-sick', status: 'running', health: 'unhealthy', at: t1 },
      ]);

      const { triggered } = evaluateAlerts(db, { alerts: cfg });
      const unhealthy = triggered.find((a: any) => a.type === 'container_unhealthy' && a.target === 'plain-sick');
      assert.ok(unhealthy);
      assert.doesNotMatch(unhealthy.message, /OOM/i);
    });
  });
});
