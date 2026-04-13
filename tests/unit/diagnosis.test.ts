import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const { createTestDb } = require('../helpers/db');
const { suppressConsole } = require('../helpers/mocks');
const { runDiagnosis } = require('../../hub/src/insights/diagnosis/run');
const { setCachedLogs, _clearCache } = require('../../hub/src/insights/diagnosis/logCache');
const { stickyFindings, _clearStickyCache } = require('../../hub/src/insights/diagnosis/sticky');

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
    _clearStickyCache();
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
    ], { db, image: 'postgres' });

    const findings = runDiagnosis(db, { type: 'container', hostId: 'h1', containerName: 'postgres' });
    assert.equal(findings.length, 1);
    // With Drain + templateClassifier, the first matching rule wins: "fatal"
    // comes before "db_locked" in SEMANTIC_RULES, so we expect a fatal label.
    assert.ok(
      findings[0]!.evidence.some((e: string) => e.toLowerCase().includes('fatal')),
      `expected evidence to mention 'fatal', got: ${JSON.stringify(findings[0]!.evidence)}`,
    );
  });

  it('regression: overlay classifier still catches OOM errors in logs (parity with pre-Drain regexes)', () => {
    for (let i = 6; i >= 0; i--) {
      seedSnapshot(db, {
        name: 'leaky', health: i === 0 ? 'unhealthy' : 'healthy',
        cpu: 10, mem: 200, restarts: 0,
        healthOutput: i === 0 ? 'probe failed' : null,
        collectedAt: ts(new Date(NOW - i * 15 * 60_000)),
      });
    }
    seedHostSnapshot(db, 'h1', 30, 4000, 16000, 1.0, ts(new Date(NOW - 60_000)));
    setCachedLogs('h1', 'leaky', [
      { stream: 'stderr', timestamp: null, message: 'runtime: out of memory' },
      { stream: 'stderr', timestamp: null, message: 'fatal: oom-killed' },
    ], { db, image: 'leaky' });

    const findings = runDiagnosis(db, { type: 'container', hostId: 'h1', containerName: 'leaky' });
    assert.equal(findings.length, 1);
    // OOM-confirmed branch should fire (the "out of memory" tag is detected).
    assert.match(findings[0]!.conclusion, /killed by the OS|memory/i);
    assert.equal(findings[0]!.confidence, 'high');
  });

  it('drain mining persists templates to log_templates table', () => {
    seedSnapshot(db, {
      name: 'nginx', health: 'unhealthy', cpu: 5, mem: 50,
      healthOutput: 'probe failed',
      collectedAt: ts(new Date(NOW - 60_000)),
    });
    seedHostSnapshot(db, 'h1', 10, 500, 4000, 0.5, ts(new Date(NOW - 60_000)));
    setCachedLogs('h1', 'nginx', [
      { stream: 'stderr', timestamp: null, message: 'upstream 10.0.0.1 failed' },
      { stream: 'stderr', timestamp: null, message: 'upstream 10.0.0.2 failed' },
      { stream: 'stderr', timestamp: null, message: 'upstream 192.168.1.5 failed' },
    ], { db, image: 'nginx' });

    const rows = db.prepare('SELECT image, template, occurrence_count FROM log_templates WHERE image = ?').all('nginx');
    assert.ok(rows.length >= 1, 'expected at least one template persisted');
    // All three lines should collapse into one template containing a wildcard.
    const upstream = rows.find((r: any) => /upstream/.test(r.template));
    assert.ok(upstream, `expected an 'upstream' template, got: ${JSON.stringify(rows)}`);
    assert.ok(
      upstream.template.includes('<*>'),
      `expected wildcard in collapsed template, got: ${upstream.template}`,
    );
    assert.equal(upstream.occurrence_count, 3);
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

  it('dedupes the health-check-output line when a signal detector already included it', () => {
    // zombieListener pushes a "Docker reports: …" evidence line itself.
    // The unified diagnoser also prepends the same line from ctx.latest.
    // Both should collapse to a single entry via the internal seen-set.
    for (let i = 6; i >= 0; i--) {
      seedSnapshot(db, {
        name: 'adguard', health: i === 0 ? 'unhealthy' : 'healthy',
        cpu: 5, mem: 110, restarts: 0,
        healthOutput: i === 0 ? "wget: can't connect: connection refused" : null,
        collectedAt: ts(new Date(NOW - i * 15 * 60_000)),
      });
    }
    seedHostSnapshot(db, 'h1', 30, 4000, 16000, 1.0, ts(new Date(NOW - 60_000)));

    const findings = runDiagnosis(db, { type: 'container', hostId: 'h1', containerName: 'adguard' });
    assert.equal(findings.length, 1);
    const dockerReports = findings[0]!.evidence.filter((e: string) => e.startsWith('Docker reports:'));
    assert.equal(
      dockerReports.length, 1,
      `expected exactly one 'Docker reports:' line, got ${dockerReports.length}: ${JSON.stringify(findings[0]!.evidence)}`,
    );
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

  it('stamps findings with diagnosedAt via sticky layer', () => {
    seedSnapshot(db, { name: 'svc', health: 'unhealthy', cpu: 10, mem: 100, healthOutput: 'boom', collectedAt: ts(new Date(NOW - 60_000)) });
    seedHostSnapshot(db, 'h1', 20, 2000, 8000, 1.0, ts(new Date(NOW - 60_000)));

    const findings = runDiagnosis(db, { type: 'container', hostId: 'h1', containerName: 'svc' });
    assert.equal(findings.length, 1);
    assert.ok(findings[0]!.diagnosedAt, 'expected diagnosedAt to be set');
    // Must be a parseable ISO timestamp
    assert.ok(!isNaN(Date.parse(findings[0]!.diagnosedAt!)));
  });
});

describe('sticky findings', () => {
  let restore: () => void;

  beforeEach(() => {
    restore = suppressConsole();
    _clearStickyCache();
  });

  afterEach(() => { restore(); });

  const baseFinding = (overrides: any = {}) => ({
    diagnoser: 'unhealthy-container',
    severity: 'warning' as const,
    confidence: 'medium' as const,
    conclusion: 'nginx is reporting unhealthy',
    evidence: ['Memory elevated (~520 MB, P95 ~400 MB)', 'CPU normal (~30%, P95 ~40%)'],
    suggestedAction: 'Restart it',
    ...overrides,
  });

  it('returns the same cached finding when conclusion + severity unchanged', () => {
    const first = stickyFindings('h1', 'nginx', [baseFinding()], 1_000_000);
    const second = stickyFindings('h1', 'nginx', [
      baseFinding({ evidence: ['Memory elevated (~530 MB, P95 ~400 MB)', 'CPU normal (~35%, P95 ~40%)'] }),
    ], 2_000_000);

    // diagnosedAt should be frozen to the first run's timestamp
    assert.equal(first[0]!.diagnosedAt, second[0]!.diagnosedAt);
    // Evidence should be the cached version, not the "drifted" one
    assert.deepEqual(second[0]!.evidence, first[0]!.evidence);
  });

  it('replaces cache and restamps when conclusion changes', () => {
    const first = stickyFindings('h1', 'nginx', [baseFinding()], 1_000_000);
    const second = stickyFindings('h1', 'nginx', [
      baseFinding({ conclusion: 'nginx is crash-looping', confidence: 'high' }),
    ], 2_000_000);

    assert.notEqual(first[0]!.diagnosedAt, second[0]!.diagnosedAt);
    assert.equal(second[0]!.conclusion, 'nginx is crash-looping');
    assert.equal(second[0]!.diagnosedAt, new Date(2_000_000).toISOString());
  });

  it('replaces cache and restamps when severity changes', () => {
    const first = stickyFindings('h1', 'nginx', [baseFinding()], 1_000_000);
    const second = stickyFindings('h1', 'nginx', [
      baseFinding({ severity: 'critical' as const }),
    ], 2_000_000);

    assert.notEqual(first[0]!.diagnosedAt, second[0]!.diagnosedAt);
    assert.equal(second[0]!.severity, 'critical');
  });

  it('keys cache per (host, container, diagnoser) — different containers do not share state', () => {
    stickyFindings('h1', 'nginx', [baseFinding()], 1_000_000);
    const other = stickyFindings('h1', 'redis', [
      baseFinding({ conclusion: 'redis is reporting unhealthy' }),
    ], 2_000_000);
    assert.equal(other[0]!.diagnosedAt, new Date(2_000_000).toISOString());
    assert.equal(other[0]!.conclusion, 'redis is reporting unhealthy');
  });
});
