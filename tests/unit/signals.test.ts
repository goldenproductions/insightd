import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { detectOom } = require('../../hub/src/insights/diagnosis/signals/oom');
const { detectCrashLoop } = require('../../hub/src/insights/diagnosis/signals/crashLoop');
const { detectCascade } = require('../../hub/src/insights/diagnosis/signals/cascade');
const { detectHostPressure } = require('../../hub/src/insights/diagnosis/signals/hostPressure');
const { detectAppErrors } = require('../../hub/src/insights/diagnosis/signals/appErrors');
const { detectZombieListener } = require('../../hub/src/insights/diagnosis/signals/zombieListener');
const { detectHungService } = require('../../hub/src/insights/diagnosis/signals/hungService');

function makeCtx(overrides: any = {}): any {
  return {
    entity: { type: 'container', hostId: 'h1', containerName: 'web', ...overrides.entity },
    now: new Date(),
    latest: {
      status: 'running',
      cpuPercent: 10,
      memoryMb: 100,
      restartCount: 0,
      healthStatus: 'unhealthy',
      healthCheckOutput: null,
      collectedAt: new Date().toISOString(),
      ...overrides.latest,
    },
    recent: {
      snapshots: [],
      cpuTrend: 'stable',
      memoryTrend: 'stable',
      restartsInWindow: 0,
      ...overrides.recent,
    },
    baselines: overrides.baselines ?? {},
    memoryVsP95: overrides.memoryVsP95 ?? null,
    cpuVsP95: overrides.cpuVsP95 ?? null,
    unhealthy: { since: null, durationMinutes: null, ...overrides.unhealthy },
    host: {
      healthScore: 90,
      cpuPercent: 20,
      memoryPercent: 30,
      load5: 1,
      underPressure: false,
      ...overrides.host,
    },
    coincident: {
      activeAlerts: [],
      recentFailures: [],
      cascadeDetected: false,
      ...overrides.coincident,
    },
    logs: {
      available: false,
      lines: [],
      errorPatterns: [],
      templates: [],
      unseenTemplates: 0,
      templateBursts: [],
      fetchedAt: null,
      ...overrides.logs,
    },
  };
}

describe('detectOom', () => {
  it('fires oom_risk when memory critical + rising', () => {
    const ctx = makeCtx({
      memoryVsP95: 'critical',
      recent: { memoryTrend: 'rising' },
      latest: { memoryMb: 700 },
      baselines: { memory_mb: { p95: 400 } },
    });
    const signal = detectOom(ctx);
    assert.ok(signal);
    assert.equal(signal!.kind, 'oom_risk');
    assert.equal(signal!.severity, 'critical');
  });

  it('fires oom_confirmed when logs contain the oom tag', () => {
    const ctx = makeCtx({
      logs: { available: true, errorPatterns: ['oom'] },
    });
    const signal = detectOom(ctx);
    assert.ok(signal);
    assert.equal(signal!.kind, 'oom_confirmed');
    // Confirmed is higher priority (smaller number) than risk.
    assert.ok(signal!.priority < 2);
  });

  it('returns null when neither condition applies', () => {
    assert.equal(detectOom(makeCtx()), null);
  });
});

describe('detectCrashLoop', () => {
  it('fires on ≥2 restarts in window', () => {
    const ctx = makeCtx({ recent: { restartsInWindow: 3 } });
    const signal = detectCrashLoop(ctx);
    assert.ok(signal);
    assert.equal(signal!.severity, 'critical');
  });

  it('returns null on 0 or 1 restart', () => {
    assert.equal(detectCrashLoop(makeCtx()), null);
    assert.equal(detectCrashLoop(makeCtx({ recent: { restartsInWindow: 1 } })), null);
  });
});

describe('detectCascade', () => {
  it('fires when cascadeDetected is true', () => {
    const ctx = makeCtx({
      coincident: { cascadeDetected: true, recentFailures: ['sib1', 'sib2', 'sib3'] },
    });
    const signal = detectCascade(ctx);
    assert.ok(signal);
    assert.equal(signal!.severity, 'warning');
  });

  it('returns null when cascade not detected', () => {
    assert.equal(detectCascade(makeCtx()), null);
  });
});

describe('detectHostPressure', () => {
  it('fires when host is under pressure', () => {
    const ctx = makeCtx({
      host: { underPressure: true, cpuPercent: 92, memoryPercent: 70, load5: 10 },
    });
    const signal = detectHostPressure(ctx);
    assert.ok(signal);
  });

  it('returns null when host is fine', () => {
    assert.equal(detectHostPressure(makeCtx()), null);
  });
});

describe('detectAppErrors', () => {
  it('fires when logs have tags + no restarts', () => {
    const ctx = makeCtx({
      logs: { available: true, errorPatterns: ['fatal', 'conn_refused'] },
    });
    const signal = detectAppErrors(ctx);
    assert.ok(signal);
    assert.match(signal!.conclusion, /fatal/);
  });

  it('returns null if the container has restarted', () => {
    const ctx = makeCtx({
      logs: { available: true, errorPatterns: ['fatal'] },
      recent: { restartsInWindow: 1 },
    });
    assert.equal(detectAppErrors(ctx), null);
  });

  it('returns null if logs are not available', () => {
    assert.equal(detectAppErrors(makeCtx()), null);
  });
});

describe('detectZombieListener', () => {
  it('fires on "connection refused" with stable resources', () => {
    const ctx = makeCtx({
      latest: { healthCheckOutput: "wget: can't connect: connection refused" },
    });
    const signal = detectZombieListener(ctx);
    assert.ok(signal);
  });

  it('returns null under host pressure', () => {
    const ctx = makeCtx({
      latest: { healthCheckOutput: 'connection refused' },
      host: { underPressure: true },
    });
    assert.equal(detectZombieListener(ctx), null);
  });
});

describe('detectHungService', () => {
  it('fires on health check timeout', () => {
    const ctx = makeCtx({ latest: { healthCheckOutput: 'request timed out after 30s' } });
    const signal = detectHungService(ctx);
    assert.ok(signal);
  });

  it('returns null under host pressure', () => {
    const ctx = makeCtx({
      latest: { healthCheckOutput: 'timeout' },
      host: { underPressure: true },
    });
    assert.equal(detectHungService(ctx), null);
  });
});
