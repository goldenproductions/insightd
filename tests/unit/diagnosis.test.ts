import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const { createTestDb } = require('../helpers/db');
const { suppressConsole } = require('../helpers/mocks');
const { runDiagnosis } = require('../../hub/src/insights/diagnosis/run');
const { setCachedLogs, _clearCache } = require('../../hub/src/insights/diagnosis/logCache');

function ts(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function seedSnapshot(db: any, opts: {
  hostId?: string; name: string; status?: string;
  cpu?: number | null; mem?: number | null; restarts?: number;
  health?: string | null; healthOutput?: string | null;
  collectedAt: string;
}): void {
  db.prepare(`
    INSERT INTO container_snapshots
    (host_id, container_name, container_id, status, cpu_percent, memory_mb, restart_count, health_status, health_check_output, collected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.hostId ?? 'h1', opts.name, 'abc123', opts.status ?? 'running',
    opts.cpu ?? null, opts.mem ?? null, opts.restarts ?? 0,
    opts.health ?? null, opts.healthOutput ?? null, opts.collectedAt,
  );
}

function seedHostSnapshot(db: any, hostId: string, cpu: number, memUsed: number, memTotal: number, load5: number, collectedAt: string): void {
  db.prepare(`
    INSERT INTO host_snapshots
    (host_id, cpu_percent, memory_total_mb, memory_used_mb, load_5, collected_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(hostId, cpu, memTotal, memUsed, load5, collectedAt);
}

function seedBaseline(db: any, entityId: string, metric: string, p50: number, p95: number): void {
  db.prepare(`
    INSERT INTO baselines (entity_type, entity_id, metric, time_bucket, p50, p75, p90, p95, p99, min_val, max_val, sample_count, computed_at)
    VALUES ('container', ?, ?, 'all', ?, ?, ?, ?, ?, ?, ?, 100, datetime('now'))
  `).run(entityId, metric, p50, p50 * 1.2, p50 * 1.4, p95, p95 * 1.1, p50 * 0.5, p95 * 1.2);
}

describe('diagnosis engine', () => {
  let db: any;
  let restore: () => void;
  const NOW = Date.now();

  beforeEach(() => {
    restore = suppressConsole();
    db = createTestDb();
    _clearCache();
  });

  afterEach(() => {
    restore();
    db.close();
  });

  it('returns no findings for a healthy container', () => {
    seedSnapshot(db, { name: 'nginx', health: 'healthy', cpu: 10, mem: 100, collectedAt: ts(new Date(NOW - 60_000)) });
    seedHostSnapshot(db, 'h1', 20, 2000, 8000, 1.0, ts(new Date(NOW - 60_000)));

    const findings = runDiagnosis(db, { type: 'container', hostId: 'h1', containerName: 'nginx' });
    assert.equal(findings.length, 0);
  });

  it('returns no findings when container has no snapshots', () => {
    const findings = runDiagnosis(db, { type: 'container', hostId: 'h1', containerName: 'missing' });
    assert.equal(findings.length, 0);
  });

  it('diagnoses OOM risk when memory critical and rising', () => {
    // Seed history showing rising memory
    for (let i = 10; i >= 0; i--) {
      seedSnapshot(db, {
        name: 'leaky', health: i === 0 ? 'unhealthy' : 'healthy',
        cpu: 30, mem: 200 + (10 - i) * 50,  // rising from 200 → 700
        healthOutput: i === 0 ? 'wget failed' : null,
        collectedAt: ts(new Date(NOW - i * 10 * 60_000)),
      });
    }
    seedHostSnapshot(db, 'h1', 30, 4000, 16000, 1.0, ts(new Date(NOW - 60_000)));
    seedBaseline(db, 'h1/leaky', 'memory_mb', 250, 400); // current 700 is >30% above P95 400

    const findings = runDiagnosis(db, { type: 'container', hostId: 'h1', containerName: 'leaky' });
    assert.equal(findings.length, 1);
    assert.match(findings[0]!.conclusion, /memory/i);
    assert.equal(findings[0]!.confidence, 'high');
  });

  it('diagnoses crash-loop when multiple restarts in window', () => {
    // Seed history with increasing restart count
    for (let i = 5; i >= 0; i--) {
      seedSnapshot(db, {
        name: 'crashy', health: i === 0 ? 'unhealthy' : 'healthy',
        cpu: 10, mem: 100, restarts: 5 - i,  // 0, 1, 2, 3, 4, 5 → 5 restarts
        healthOutput: i === 0 ? 'connection refused' : null,
        collectedAt: ts(new Date(NOW - i * 15 * 60_000)),
      });
    }
    seedHostSnapshot(db, 'h1', 30, 4000, 16000, 1.0, ts(new Date(NOW - 60_000)));

    const findings = runDiagnosis(db, { type: 'container', hostId: 'h1', containerName: 'crashy' });
    assert.equal(findings.length, 1);
    assert.match(findings[0]!.conclusion, /crash-looping/i);
    assert.equal(findings[0]!.confidence, 'high');
    assert.equal(findings[0]!.severity, 'critical');
  });

  it('diagnoses host-under-pressure when host CPU is high', () => {
    seedSnapshot(db, {
      name: 'web', health: 'unhealthy', cpu: 5, mem: 100,
      healthOutput: 'wget: connection refused',
      collectedAt: ts(new Date(NOW - 60_000)),
    });
    seedHostSnapshot(db, 'h1', 92, 4000, 16000, 10, ts(new Date(NOW - 60_000)));

    const findings = runDiagnosis(db, { type: 'container', hostId: 'h1', containerName: 'web' });
    assert.equal(findings.length, 1);
    assert.match(findings[0]!.conclusion, /under resource pressure/i);
  });

  it('diagnoses cascade when multiple containers fail on the same host', () => {
    seedSnapshot(db, { name: 'web', health: 'unhealthy', cpu: 5, mem: 100, healthOutput: 'refused', collectedAt: ts(new Date(NOW - 60_000)) });
    // Three sibling containers with 'exited' snapshot = recent failures
    for (const n of ['sib1', 'sib2', 'sib3']) {
      seedSnapshot(db, { name: n, status: 'exited', cpu: 0, mem: 0, collectedAt: ts(new Date(NOW - 10 * 60_000)) });
      seedSnapshot(db, { name: n, status: 'exited', cpu: 0, mem: 0, collectedAt: ts(new Date(NOW - 60_000)) });
    }
    seedHostSnapshot(db, 'h1', 30, 4000, 16000, 2.0, ts(new Date(NOW - 60_000)));

    const findings = runDiagnosis(db, { type: 'container', hostId: 'h1', containerName: 'web' });
    assert.equal(findings.length, 1);
    assert.match(findings[0]!.conclusion, /wider failure|cascade/i);
  });

  it('diagnoses zombie listener for connection refused with stable resources', () => {
    // Stable, healthy history, no restarts
    for (let i = 6; i >= 0; i--) {
      seedSnapshot(db, {
        name: 'adguard', health: i === 0 ? 'unhealthy' : 'healthy',
        cpu: 5, mem: 110, restarts: 0,
        healthOutput: i === 0 ? "wget: can't connect to remote host: Connection refused" : null,
        collectedAt: ts(new Date(NOW - i * 15 * 60_000)),
      });
    }
    seedHostSnapshot(db, 'h1', 30, 4000, 16000, 1.0, ts(new Date(NOW - 60_000)));
    seedBaseline(db, 'h1/adguard', 'memory_mb', 108, 120); // current 110 is normal
    seedBaseline(db, 'h1/adguard', 'cpu_percent', 5, 8);

    const findings = runDiagnosis(db, { type: 'container', hostId: 'h1', containerName: 'adguard' });
    assert.equal(findings.length, 1);
    assert.match(findings[0]!.conclusion, /listener|zombie|not responding/i);
  });

  it('uses log patterns to diagnose service errors', () => {
    for (let i = 6; i >= 0; i--) {
      seedSnapshot(db, {
        name: 'postgres', health: i === 0 ? 'unhealthy' : 'healthy',
        cpu: 10, mem: 200, restarts: 0,
        healthOutput: i === 0 ? 'pg_isready: no response' : null,
        collectedAt: ts(new Date(NOW - i * 15 * 60_000)),
      });
    }
    seedHostSnapshot(db, 'h1', 30, 4000, 16000, 1.0, ts(new Date(NOW - 60_000)));
    setCachedLogs('h1', 'postgres', [
      { stream: 'stderr', timestamp: null, message: 'FATAL: database "foo" does not exist' },
      { stream: 'stderr', timestamp: null, message: 'FATAL: database is locked' },
    ]);

    const findings = runDiagnosis(db, { type: 'container', hostId: 'h1', containerName: 'postgres' });
    assert.equal(findings.length, 1);
    assert.ok(findings[0]!.evidence.some((e: string) => e.includes('fatal') || e.includes('database')));
  });

  it('falls back gracefully when nothing stands out', () => {
    seedSnapshot(db, {
      name: 'mystery', health: 'unhealthy', cpu: 20, mem: 200, restarts: 0,
      healthOutput: 'check returned exit code 1',
      collectedAt: ts(new Date(NOW - 60_000)),
    });
    seedHostSnapshot(db, 'h1', 30, 4000, 16000, 1.0, ts(new Date(NOW - 60_000)));

    const findings = runDiagnosis(db, { type: 'container', hostId: 'h1', containerName: 'mystery' });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.confidence, 'low');
  });

  it('persists findings when persistCategory is set', () => {
    seedSnapshot(db, {
      name: 'svc', health: 'unhealthy', cpu: 5, mem: 100,
      healthOutput: 'wget: connection refused',
      collectedAt: ts(new Date(NOW - 60_000)),
    });
    seedHostSnapshot(db, 'h1', 30, 4000, 16000, 1.0, ts(new Date(NOW - 60_000)));

    runDiagnosis(db, { type: 'container', hostId: 'h1', containerName: 'svc' }, { persistCategory: 'health' });

    const persisted = db.prepare("SELECT * FROM insights WHERE category = 'health'").all();
    assert.equal(persisted.length, 1);
    assert.ok(persisted[0]!.evidence); // JSON array
    assert.ok(persisted[0]!.suggested_action);
    assert.ok(persisted[0]!.confidence);
  });
});
