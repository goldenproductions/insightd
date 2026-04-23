import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
const { createTestDb, seedContainerSnapshots } = require('../helpers/db');
const { ts, NOW } = require('../helpers/fixtures');
const { suppressConsole } = require('../helpers/mocks');

const nodemailer = require('nodemailer');

describe('evaluateAlerts — container resource limit saturation (hub, v36)', () => {
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
    containerUnhealthy: false, excludeContainers: '',
    endpointDown: false, endpointFailureThreshold: 3,
    containerMemoryLimitPercent: 90,
    containerCpuLimitPercent: 90,
  };

  function setLimits(containerName: string, overrides: { cpuLimitCores?: number | null; cpuLimitPercent?: number | null; memoryLimitMb?: number | null }): void {
    db.prepare(`
      UPDATE container_snapshots
      SET cpu_limit_cores = ?, cpu_limit_percent = ?, memory_limit_mb = ?
      WHERE container_name = ?
    `).run(
      overrides.cpuLimitCores ?? null,
      overrides.cpuLimitPercent ?? null,
      overrides.memoryLimitMb ?? null,
      containerName,
    );
  }

  it('fires container_memory_saturation at 94% with threshold 90', () => {
    seedContainerSnapshots(db, [
      { name: 'memtest', status: 'running', mem: 120, at: ts(NOW) },
    ]);
    setLimits('memtest', { memoryLimitMb: 128 });

    const { triggered } = evaluateAlerts(db, { alerts: cfg });
    const sat = triggered.filter((a: any) => a.type === 'container_memory_saturation');
    assert.equal(sat.length, 1);
    assert.equal(sat[0].target, 'memtest');
    assert.match(sat[0].message, /93\.8|94\.?%/);
  });

  it('does not fire when well under threshold', () => {
    seedContainerSnapshots(db, [
      { name: 'calm', status: 'running', mem: 64, at: ts(NOW) },
    ]);
    setLimits('calm', { memoryLimitMb: 128 });  // 50%

    const { triggered } = evaluateAlerts(db, { alerts: cfg });
    assert.equal(triggered.filter((a: any) => a.type === 'container_memory_saturation').length, 0);
  });

  it('skips containers with no memory limit set (Docker / unlimited k8s)', () => {
    seedContainerSnapshots(db, [
      { name: 'nolimit', status: 'running', mem: 5000, at: ts(NOW) },
    ]);
    // No limits set — memoryLimitMb stays null.

    const { triggered } = evaluateAlerts(db, { alerts: cfg });
    assert.equal(triggered.filter((a: any) => a.type === 'container_memory_saturation').length, 0);
  });

  it('fires container_cpu_saturation at 95% with threshold 90', () => {
    seedContainerSnapshots(db, [
      { name: 'burny', status: 'running', cpu: 50, mem: 100, at: ts(NOW) },
    ]);
    setLimits('burny', { cpuLimitCores: 0.5, cpuLimitPercent: 95 });

    const { triggered } = evaluateAlerts(db, { alerts: cfg });
    const sat = triggered.filter((a: any) => a.type === 'container_cpu_saturation');
    assert.equal(sat.length, 1);
    assert.equal(sat[0].target, 'burny');
  });

  it('disabled when threshold is 0', () => {
    seedContainerSnapshots(db, [
      { name: 'memtest', status: 'running', mem: 127, at: ts(NOW) },
    ]);
    setLimits('memtest', { memoryLimitMb: 128 });  // 99.2%

    const disabledCfg = { ...cfg, containerMemoryLimitPercent: 0 };
    const { triggered } = evaluateAlerts(db, { alerts: disabledCfg });
    assert.equal(triggered.filter((a: any) => a.type === 'container_memory_saturation').length, 0);
  });

  it('resolves container_memory_saturation when usage drops below threshold', () => {
    // Simulate a prior saturation alert in alert_state, then a snapshot at 50%.
    seedContainerSnapshots(db, [
      { name: 'memtest', status: 'running', mem: 60, at: ts(NOW) },
    ]);
    setLimits('memtest', { memoryLimitMb: 128 });  // 46.9%
    db.prepare(`
      INSERT INTO alert_state (host_id, alert_type, target, triggered_at)
      VALUES ('local', 'container_memory_saturation', 'memtest', ?)
    `).run(ts(new Date(NOW - 600_000)));

    const { resolved } = evaluateAlerts(db, { alerts: cfg });
    const r = resolved.filter((x: any) => x.type === 'container_memory_saturation');
    assert.equal(r.length, 1);
    assert.equal(r[0].target, 'memtest');
  });

  it('resolves container_cpu_saturation when cpu_limit_percent drops below threshold', () => {
    seedContainerSnapshots(db, [
      { name: 'burny', status: 'running', cpu: 5, mem: 100, at: ts(NOW) },
    ]);
    setLimits('burny', { cpuLimitCores: 0.5, cpuLimitPercent: 10 });
    db.prepare(`
      INSERT INTO alert_state (host_id, alert_type, target, triggered_at)
      VALUES ('local', 'container_cpu_saturation', 'burny', ?)
    `).run(ts(new Date(NOW - 600_000)));

    const { resolved } = evaluateAlerts(db, { alerts: cfg });
    const r = resolved.filter((x: any) => x.type === 'container_cpu_saturation');
    assert.equal(r.length, 1);
  });
});
