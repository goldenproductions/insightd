import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
const { createTestDb } = require('../helpers/db');
const { suppressConsole } = require('../helpers/mocks');

const nodemailer = require('nodemailer');

describe('evaluateAlerts — pod_pending', () => {
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
    containerDown: false, restartCount: 0,
    cpuPercent: 0, memoryMb: 0, diskPercent: 0,
    hostCpuPercent: 0, hostMemoryAvailableMb: 0, hostLoadThreshold: 0,
    hostOffline: false, hostOfflineMinutes: 0,
    containerUnhealthy: false, excludeContainers: '',
    endpointDown: false, endpointFailureThreshold: 3,
    podPending: true, podPendingMinutes: 5,
  };

  function insertPending(opts: {
    cluster?: string; ns?: string; pod: string;
    reason?: string | null; message?: string | null;
    workloadKind?: string | null; workloadName?: string | null;
    firstSeenAgoMinutes?: number;
  }): void {
    const cluster = opts.cluster ?? 'k3s';
    const ns = opts.ns ?? 'default';
    const ago = opts.firstSeenAgoMinutes ?? 10;
    db.prepare(`
      INSERT INTO pending_pods (cluster_id, namespace, pod_name, reason, message, pod_phase,
                                pod_created_at, workload_kind, workload_name, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, 'Pending', NULL, ?, ?, datetime('now', ?), datetime('now'))
    `).run(cluster, ns, opts.pod,
      opts.reason ?? null, opts.message ?? null,
      opts.workloadKind ?? null, opts.workloadName ?? null,
      `-${ago} minutes`);
  }

  it('fires pod_pending when first_seen_at is older than threshold', () => {
    insertPending({ pod: 'web-7d-xyz', reason: 'Unschedulable', message: '0/3 nodes available', firstSeenAgoMinutes: 10 });
    const { triggered } = evaluateAlerts(db, { alerts: cfg });
    const fired = triggered.filter((a: any) => a.type === 'pod_pending');
    assert.equal(fired.length, 1);
    assert.equal(fired[0].hostId, 'k3s');
    assert.equal(fired[0].target, 'default/web-7d-xyz');
    assert.match(fired[0].message, /Unschedulable/);
    assert.match(fired[0].message, /0\/3 nodes available/);
  });

  it('does not fire below threshold', () => {
    insertPending({ pod: 'recent', firstSeenAgoMinutes: 2 });
    const { triggered } = evaluateAlerts(db, { alerts: cfg });
    assert.equal(triggered.filter((a: any) => a.type === 'pod_pending').length, 0);
  });

  it('respects the podPending=false toggle', () => {
    insertPending({ pod: 'web-7d-xyz', firstSeenAgoMinutes: 60 });
    const { triggered } = evaluateAlerts(db, { alerts: { ...cfg, podPending: false } });
    assert.equal(triggered.filter((a: any) => a.type === 'pod_pending').length, 0);
  });

  it('includes workload owner in message when present', () => {
    insertPending({ pod: 'web-7d-xyz', workloadKind: 'ReplicaSet', workloadName: 'web-7d', firstSeenAgoMinutes: 10 });
    const { triggered } = evaluateAlerts(db, { alerts: cfg });
    const fired = triggered.find((a: any) => a.type === 'pod_pending');
    assert.match(fired.message, /ReplicaSet\/web-7d/);
  });

  it('auto-resolves pod_pending when row is gone (left Pending or removed)', () => {
    insertPending({ pod: 'web-7d-xyz', firstSeenAgoMinutes: 10 });
    // Simulate the alert was already triggered + persisted as active.
    db.prepare(`
      INSERT INTO alert_state (host_id, alert_type, target, triggered_at, last_notified, notify_count, trigger_value)
      VALUES (?, 'pod_pending', ?, datetime('now', '-1 hour'), datetime('now', '-1 hour'), 1, 'Unschedulable')
    `).run('k3s', 'default/web-7d-xyz');
    // Pod left Pending — row removed by the next ingest cycle.
    db.prepare('DELETE FROM pending_pods').run();

    const { resolved } = evaluateAlerts(db, { alerts: cfg });
    const r = resolved.find((a: any) => a.type === 'pod_pending');
    assert.ok(r, 'auto-resolution fired');
    assert.equal(r.target, 'default/web-7d-xyz');
    assert.match(r.message, /no longer Pending/);
  });

  it('does not auto-resolve while the pod row is still present', () => {
    insertPending({ pod: 'web-7d-xyz', firstSeenAgoMinutes: 10 });
    db.prepare(`
      INSERT INTO alert_state (host_id, alert_type, target, triggered_at, last_notified, notify_count, trigger_value)
      VALUES ('k3s', 'pod_pending', 'default/web-7d-xyz', datetime('now', '-1 hour'), datetime('now', '-1 hour'), 1, 'Unschedulable')
    `).run();
    const { resolved } = evaluateAlerts(db, { alerts: cfg });
    assert.equal(resolved.filter((a: any) => a.type === 'pod_pending').length, 0);
  });
});
