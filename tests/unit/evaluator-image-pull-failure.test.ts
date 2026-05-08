import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
const { createTestDb } = require('../helpers/db');
const { suppressConsole } = require('../helpers/mocks');
const nodemailer = require('nodemailer');

describe('evaluateAlerts — image_pull_failure', () => {
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
    db.prepare(
      `INSERT INTO hosts (host_id, first_seen, last_seen, runtime_type)
       VALUES ('k3s', datetime('now'), datetime('now'), 'kubernetes')`
    ).run();
  });

  afterEach(() => {
    db.close();
    restore();
    mock.restoreAll();
  });

  // Minimal evaluator config — only the container-health checks and
  // their friends. Other alert types stay disabled so the test output
  // doesn't have to filter through unrelated noise.
  const cfg = {
    enabled: true, to: 't@t.com', cooldownMinutes: 60,
    containerDown: false, restartCount: 0,
    cpuPercent: 0, memoryMb: 0, diskPercent: 0,
    hostCpuPercent: 0, hostMemoryAvailableMb: 0, hostLoadThreshold: 0,
    hostOffline: false, hostOfflineMinutes: 0,
    containerUnhealthy: true,
    imagePullFailure: true,
    excludeContainers: '',
    endpointDown: false, endpointFailureThreshold: 3,
    containerMemoryLimitPercent: 0, containerCpuLimitPercent: 0,
    certExpiry: false,
    podPending: false,
    workloadUnavailable: false, workloadDegraded: false, workloadRolloutStuck: false,
  };

  function seedUnhealthy(opts: { name: string; output: string | null; hostId?: string }) {
    const host = opts.hostId ?? 'k3s';
    db.prepare(`
      INSERT INTO container_snapshots
        (host_id, container_name, container_id, status, restart_count,
         health_status, health_check_output, collected_at)
      VALUES (?, ?, ?, 'running', 0, 'unhealthy', ?, datetime('now'))
    `).run(host, opts.name, `cid-${opts.name}`, opts.output);
    // Mirror the production ingest path — a snapshot insert always upserts
    // the registry row so the stale-target auto-resolve doesn't trip in
    // tests that exercise the type-specific resolver.
    db.prepare(`
      INSERT INTO containers (host_id, container_name, first_seen, last_seen, removed_at)
      VALUES (?, ?, datetime('now'), datetime('now'), NULL)
      ON CONFLICT(host_id, container_name) DO UPDATE SET
        last_seen = datetime('now'),
        removed_at = NULL
    `).run(host, opts.name);
  }

  it('fires image_pull_failure for ImagePullBackOff and not container_unhealthy', () => {
    seedUnhealthy({ name: 'web', output: 'ImagePullBackOff: Back-off pulling image "foo:bad"' });
    const { triggered } = evaluateAlerts(db, { alerts: cfg });
    const ipf = triggered.filter((a: any) => a.type === 'image_pull_failure');
    const cu = triggered.filter((a: any) => a.type === 'container_unhealthy');
    assert.equal(ipf.length, 1);
    assert.equal(cu.length, 0, 'image-pull rows must not double-fire as container_unhealthy');
    assert.equal(ipf[0].target, 'web');
    assert.equal(ipf[0].hostId, 'k3s');
    assert.match(ipf[0].message, /can't pull its image/);
    assert.match(ipf[0].message, /imagePullSecrets/);
    assert.equal(ipf[0].value, 'ImagePullBackOff');
  });

  it('fires image_pull_failure for ErrImagePull, InvalidImageName, CreateContainerConfigError', () => {
    seedUnhealthy({ name: 'a', output: 'ErrImagePull: rpc error' });
    seedUnhealthy({ name: 'b', output: 'InvalidImageName: ":latest" is not valid' });
    seedUnhealthy({ name: 'c', output: 'CreateContainerConfigError: secret "missing" not found' });
    const { triggered } = evaluateAlerts(db, { alerts: cfg });
    const targets = triggered.filter((a: any) => a.type === 'image_pull_failure').map((a: any) => a.target).sort();
    assert.deepEqual(targets, ['a', 'b', 'c']);
    const cccfg = triggered.find((a: any) => a.target === 'c' && a.type === 'image_pull_failure');
    assert.match(cccfg!.message, /ConfigMap\/Secret/);
  });

  it('matches reasons even when they appear with no trailing message', () => {
    seedUnhealthy({ name: 'bare', output: 'ImagePullBackOff' });
    const { triggered } = evaluateAlerts(db, { alerts: cfg });
    assert.equal(triggered.filter((a: any) => a.type === 'image_pull_failure').length, 1);
  });

  it('still fires container_unhealthy for non-pull reasons (CrashLoopBackOff)', () => {
    seedUnhealthy({ name: 'crasher', output: 'CrashLoopBackOff: back-off 5m0s restarting failed container' });
    const { triggered } = evaluateAlerts(db, { alerts: cfg });
    assert.equal(triggered.filter((a: any) => a.type === 'image_pull_failure').length, 0);
    assert.equal(triggered.filter((a: any) => a.type === 'container_unhealthy').length, 1);
  });

  it('falls back to container_unhealthy for image-pull rows when imagePullFailure=false', () => {
    seedUnhealthy({ name: 'web', output: 'ImagePullBackOff: bad' });
    const { triggered } = evaluateAlerts(db, { alerts: { ...cfg, imagePullFailure: false } });
    assert.equal(triggered.filter((a: any) => a.type === 'image_pull_failure').length, 0);
    assert.equal(triggered.filter((a: any) => a.type === 'container_unhealthy').length, 1);
  });

  it('does not fire image_pull_failure when imagePullFailure=false', () => {
    seedUnhealthy({ name: 'web', output: 'ImagePullBackOff: bad' });
    const { triggered } = evaluateAlerts(db, { alerts: { ...cfg, imagePullFailure: false } });
    assert.equal(triggered.filter((a: any) => a.type === 'image_pull_failure').length, 0);
  });

  it('resolves image_pull_failure when health flips to healthy', () => {
    seedUnhealthy({ name: 'web', output: 'ImagePullBackOff' });
    db.prepare(`
      INSERT INTO alert_state (host_id, alert_type, target, triggered_at, last_notified, notify_count, message)
      VALUES ('k3s', 'image_pull_failure', 'web', datetime('now', '-1 hour'), datetime('now', '-1 hour'), 1, 'pull failed')
    `).run();
    // Newer snapshot with healthy status — should clear the alert.
    db.prepare(`
      INSERT INTO container_snapshots
        (host_id, container_name, container_id, status, restart_count,
         health_status, health_check_output, collected_at)
      VALUES ('k3s', 'web', 'cid-web', 'running', 0, 'healthy', NULL, datetime('now', '+1 second'))
    `).run();
    const { resolved } = evaluateAlerts(db, { alerts: cfg });
    const r = resolved.find((a: any) => a.type === 'image_pull_failure' && a.target === 'web');
    assert.ok(r);
    assert.match(r!.message, /pulled its image successfully/);
  });

  it('resolves image_pull_failure when the unhealthy reason flips to a non-pull cause (CrashLoop takes over)', () => {
    // Pull succeeded but the container now crashes — image_pull_failure
    // should resolve and container_unhealthy should re-fire on the same
    // pass with the new cause.
    seedUnhealthy({ name: 'web', output: 'CrashLoopBackOff: back-off 5m0s' });
    db.prepare(`
      INSERT INTO alert_state (host_id, alert_type, target, triggered_at, last_notified, notify_count, message)
      VALUES ('k3s', 'image_pull_failure', 'web', datetime('now', '-1 hour'), datetime('now', '-1 hour'), 1, 'pull failed')
    `).run();
    const { triggered, resolved } = evaluateAlerts(db, { alerts: cfg });
    assert.ok(resolved.find((a: any) => a.type === 'image_pull_failure' && a.target === 'web'));
    assert.ok(triggered.find((a: any) => a.type === 'container_unhealthy' && a.target === 'web'));
  });
});
