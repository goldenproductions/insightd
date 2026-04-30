import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
const { createTestDb } = require('../helpers/db');
const { suppressConsole } = require('../helpers/mocks');

const nodemailer = require('nodemailer');

describe('evaluateAlerts — workload rollouts', () => {
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
    podPending: false,
    workloadUnavailable: true, workloadUnavailableMinutes: 10,
    workloadDegraded: true, workloadDegradedMinutes: 10,
    workloadRolloutStuck: true, workloadRolloutStuckMinutes: 10,
  };

  function insertRollout(opts: {
    cluster?: string; kind?: 'Deployment' | 'StatefulSet' | 'DaemonSet';
    ns?: string; name: string;
    desired: number; ready: number; updated?: number;
    progressDeadlineExceeded?: boolean;
    firstSeenAgoMinutes?: number;
  }): void {
    const cluster = opts.cluster ?? 'k3s';
    const kind = opts.kind ?? 'Deployment';
    const ns = opts.ns ?? 'default';
    const updated = opts.updated ?? opts.desired;
    const ago = opts.firstSeenAgoMinutes ?? 30;
    db.prepare(`
      INSERT INTO workload_rollouts
        (cluster_id, kind, namespace, name, desired, ready, updated,
         generation, observed_generation, progress_deadline_exceeded,
         first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, datetime('now', ?), datetime('now'))
    `).run(
      cluster, kind, ns, opts.name,
      opts.desired, opts.ready, updated,
      opts.progressDeadlineExceeded ? 1 : 0,
      `-${ago} minutes`,
    );
  }

  // ── workload_unavailable (critical) ────────────────────────────────────────

  it('fires workload_unavailable when ready=0 past threshold', () => {
    insertRollout({ name: 'api', desired: 3, ready: 0, firstSeenAgoMinutes: 30 });
    const { triggered } = evaluateAlerts(db, { alerts: cfg });
    const fired = triggered.filter((a: any) => a.type === 'workload_unavailable');
    assert.equal(fired.length, 1);
    assert.equal(fired[0].hostId, 'k3s');
    assert.equal(fired[0].target, 'Deployment/default/api');
    assert.match(fired[0].message, /unavailable/);
    assert.match(fired[0].message, /0\/3/);
  });

  it('does not fire workload_unavailable below threshold', () => {
    insertRollout({ name: 'api', desired: 3, ready: 0, firstSeenAgoMinutes: 5 });
    const { triggered } = evaluateAlerts(db, { alerts: cfg });
    assert.equal(triggered.filter((a: any) => a.type === 'workload_unavailable').length, 0);
  });

  it('does not fire workload_unavailable when desired=0', () => {
    insertRollout({ name: 'idle', desired: 0, ready: 0, firstSeenAgoMinutes: 30 });
    const { triggered } = evaluateAlerts(db, { alerts: cfg });
    assert.equal(triggered.filter((a: any) => a.type === 'workload_unavailable').length, 0);
  });

  // ── workload_degraded (error) ──────────────────────────────────────────────

  it('fires workload_degraded when 0<ready<desired', () => {
    insertRollout({ name: 'api', desired: 3, ready: 1, firstSeenAgoMinutes: 30 });
    const { triggered } = evaluateAlerts(db, { alerts: cfg });
    const fired = triggered.filter((a: any) => a.type === 'workload_degraded');
    assert.equal(fired.length, 1);
    assert.equal(fired[0].target, 'Deployment/default/api');
    assert.match(fired[0].message, /degraded/);
    assert.match(fired[0].message, /1\/3/);
  });

  it('unavailable and degraded are mutually exclusive on the same row', () => {
    insertRollout({ name: 'api', desired: 3, ready: 0, firstSeenAgoMinutes: 30 });
    const { triggered } = evaluateAlerts(db, { alerts: cfg });
    assert.equal(triggered.filter((a: any) => a.type === 'workload_unavailable').length, 1);
    assert.equal(triggered.filter((a: any) => a.type === 'workload_degraded').length, 0);
  });

  it('fires neither when fully ready', () => {
    insertRollout({ name: 'api', desired: 3, ready: 3, firstSeenAgoMinutes: 30 });
    const { triggered } = evaluateAlerts(db, { alerts: cfg });
    assert.equal(triggered.filter((a: any) =>
      a.type === 'workload_unavailable' || a.type === 'workload_degraded'
    ).length, 0);
  });

  // ── workload_rollout_stuck (warning) ───────────────────────────────────────

  it('fires workload_rollout_stuck on ProgressDeadlineExceeded immediately', () => {
    // No threshold gate when the controller has explicitly given up.
    insertRollout({
      name: 'api', desired: 3, ready: 3, updated: 3,
      progressDeadlineExceeded: true,
      firstSeenAgoMinutes: 30,
    });
    const { triggered } = evaluateAlerts(db, { alerts: cfg });
    const fired = triggered.filter((a: any) => a.type === 'workload_rollout_stuck');
    assert.equal(fired.length, 1);
    assert.match(fired[0].message, /ProgressDeadlineExceeded/);
  });

  it('fires workload_rollout_stuck on updated<desired past threshold', () => {
    // For STS/DS where ProgressDeadline doesn't apply.
    insertRollout({
      kind: 'StatefulSet', name: 'db', desired: 3, ready: 3, updated: 1,
      firstSeenAgoMinutes: 30,
    });
    const { triggered } = evaluateAlerts(db, { alerts: cfg });
    const fired = triggered.filter((a: any) => a.type === 'workload_rollout_stuck');
    assert.equal(fired.length, 1);
    assert.equal(fired[0].target, 'StatefulSet/default/db');
    assert.match(fired[0].message, /1\/3 updated/);
  });

  it('does not fire workload_rollout_stuck when ready=0 (already unavailable)', () => {
    insertRollout({
      name: 'api', desired: 3, ready: 0, updated: 0,
      progressDeadlineExceeded: true,
      firstSeenAgoMinutes: 30,
    });
    const { triggered } = evaluateAlerts(db, { alerts: cfg });
    assert.equal(triggered.filter((a: any) => a.type === 'workload_rollout_stuck').length, 0);
    // The unavailable alert is the louder signal in this state.
    assert.equal(triggered.filter((a: any) => a.type === 'workload_unavailable').length, 1);
  });

  // ── toggles ────────────────────────────────────────────────────────────────

  it('respects the workloadUnavailable=false toggle', () => {
    insertRollout({ name: 'api', desired: 3, ready: 0, firstSeenAgoMinutes: 30 });
    const { triggered } = evaluateAlerts(db, { alerts: { ...cfg, workloadUnavailable: false } });
    assert.equal(triggered.filter((a: any) => a.type === 'workload_unavailable').length, 0);
  });

  // ── auto-resolution ────────────────────────────────────────────────────────

  it('auto-resolves workload_unavailable when ready transitions up', () => {
    // Row exists with ready=2 (degraded, not unavailable). Pre-existing alert
    // for the unavailable state should resolve.
    insertRollout({ name: 'api', desired: 3, ready: 2, firstSeenAgoMinutes: 30 });
    db.prepare(`
      INSERT INTO alert_state (host_id, alert_type, target, triggered_at, last_notified, notify_count, trigger_value)
      VALUES ('k3s', 'workload_unavailable', 'Deployment/default/api', datetime('now', '-1 hour'), datetime('now', '-1 hour'), 1, '0')
    `).run();
    const { resolved } = evaluateAlerts(db, { alerts: cfg });
    const r = resolved.find((a: any) => a.type === 'workload_unavailable');
    assert.ok(r, 'auto-resolution fired');
    assert.equal(r.target, 'Deployment/default/api');
  });

  it('auto-resolves workload_degraded when fully ready', () => {
    insertRollout({ name: 'api', desired: 3, ready: 3, firstSeenAgoMinutes: 30 });
    db.prepare(`
      INSERT INTO alert_state (host_id, alert_type, target, triggered_at, last_notified, notify_count, trigger_value)
      VALUES ('k3s', 'workload_degraded', 'Deployment/default/api', datetime('now', '-1 hour'), datetime('now', '-1 hour'), 1, '1')
    `).run();
    const { resolved } = evaluateAlerts(db, { alerts: cfg });
    const r = resolved.find((a: any) => a.type === 'workload_degraded');
    assert.ok(r, 'auto-resolution fired');
  });

  it('auto-resolves workload alerts when row is gone (workload deleted)', () => {
    db.prepare(`
      INSERT INTO alert_state (host_id, alert_type, target, triggered_at, last_notified, notify_count, trigger_value)
      VALUES ('k3s', 'workload_unavailable', 'Deployment/default/gone', datetime('now', '-1 hour'), datetime('now', '-1 hour'), 1, '0')
    `).run();
    const { resolved } = evaluateAlerts(db, { alerts: cfg });
    const r = resolved.find((a: any) => a.type === 'workload_unavailable');
    assert.ok(r, 'auto-resolution fired for deleted workload');
  });

  it('auto-resolves workload_rollout_stuck when updated catches up', () => {
    insertRollout({
      name: 'api', desired: 3, ready: 3, updated: 3,
      progressDeadlineExceeded: false,
      firstSeenAgoMinutes: 30,
    });
    db.prepare(`
      INSERT INTO alert_state (host_id, alert_type, target, triggered_at, last_notified, notify_count, trigger_value)
      VALUES ('k3s', 'workload_rollout_stuck', 'Deployment/default/api', datetime('now', '-1 hour'), datetime('now', '-1 hour'), 1, '1')
    `).run();
    const { resolved } = evaluateAlerts(db, { alerts: cfg });
    const r = resolved.find((a: any) => a.type === 'workload_rollout_stuck');
    assert.ok(r, 'auto-resolution fired');
  });
});
