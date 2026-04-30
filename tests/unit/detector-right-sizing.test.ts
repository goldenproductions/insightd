import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const { createTestDb } = require('../helpers/db');
const { suppressConsole } = require('../helpers/mocks');
const { generateInsights } = require('../../hub/src/insights/detector');

interface Insight {
  entity_type: string; entity_id: string; category: string; severity: string;
  title: string; message: string; suggested_action: string | null;
}

describe('detector — right-sizing insights', () => {
  let db: any, restore: () => void;

  beforeEach(() => {
    restore = suppressConsole();
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
    restore();
  });

  // Set a hosts row with a host_group so the detector's COALESCE picks up
  // a cluster_id. Without this the right-sizing detector skips the row.
  function seedK8sHost(hostId: string, cluster = 'k3s'): void {
    db.prepare(`
      INSERT INTO hosts (host_id, first_seen, last_seen, host_group, runtime_type)
      VALUES (?, datetime('now'), datetime('now'), ?, 'kubernetes')
    `).run(hostId, cluster);
  }

  function seedSnapshot(opts: {
    hostId?: string;
    containerName: string;
    workloadKind?: string;
    cpuPercent?: number;
    memoryMb?: number;
    cpuLimitCores?: number | null;
    memoryLimitMb?: number | null;
    cpuRequestCores?: number | null;
    memoryRequestMb?: number | null;
    at?: string;
  }): void {
    const hostId = opts.hostId ?? 'node-1';
    const at = opts.at ?? new Date().toISOString().replace('T', ' ').slice(0, 19);
    db.prepare(`
      INSERT INTO container_snapshots
        (host_id, container_name, container_id, status, cpu_percent, memory_mb, restart_count,
         cpu_limit_cores, memory_limit_mb, cpu_request_cores, memory_request_mb,
         workload_kind, collected_at)
      VALUES (?, ?, ?, 'running', ?, ?, 0, ?, ?, ?, ?, ?, ?)
    `).run(
      hostId, opts.containerName, `${hostId}/${opts.containerName}`,
      opts.cpuPercent ?? null, opts.memoryMb ?? null,
      opts.cpuLimitCores ?? null, opts.memoryLimitMb ?? null,
      opts.cpuRequestCores ?? null, opts.memoryRequestMb ?? null,
      opts.workloadKind ?? 'Deployment',
      at,
    );
    db.prepare(`
      INSERT INTO containers (host_id, container_name, first_seen, last_seen, removed_at)
      VALUES (?, ?, datetime('now'), datetime('now'), NULL)
      ON CONFLICT(host_id, container_name) DO UPDATE SET last_seen = excluded.last_seen, removed_at = NULL
    `).run(hostId, opts.containerName);
  }

  // Seed a baseline row directly. RIGHT_SIZING_MIN_SAMPLES = 288.
  function seedBaseline(entityId: string, metric: 'cpu_percent' | 'memory_mb', p95: number, sampleCount = 500): void {
    db.prepare(`
      INSERT OR REPLACE INTO baselines
        (entity_type, entity_id, metric, time_bucket, p50, p75, p90, p95, p99, min_val, max_val, sample_count, computed_at)
      VALUES ('container', ?, ?, 'all', ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(entityId, metric, p95 * 0.5, p95 * 0.75, p95 * 0.9, p95, p95 * 1.05, 0, p95 * 1.1, sampleCount);
  }

  function getInsights(): Insight[] {
    return db.prepare(
      "SELECT entity_type, entity_id, category, severity, title, message, suggested_action FROM insights WHERE category = 'right_sizing'"
    ).all() as Insight[];
  }

  // ── Memory over-provisioned ────────────────────────────────────────────────

  it('fires memory over-provisioned when P95 < 30% of request', () => {
    seedK8sHost('node-1');
    seedSnapshot({
      containerName: 'default/api/web',
      memoryRequestMb: 500,
      memoryLimitMb: 1000,
      cpuRequestCores: 0.1,
    });
    seedBaseline('node-1/default/api/web', 'memory_mb', 100);

    generateInsights(db);

    const insights = getInsights();
    const over = insights.find(i => i.title.includes('over-provisioned on memory'));
    assert.ok(over, `expected over-provisioned insight, got: ${JSON.stringify(insights)}`);
    assert.equal(over!.entity_type, 'workload');
    assert.equal(over!.entity_id, 'k3s/Deployment/default/api');
    assert.equal(over!.severity, 'info');
    assert.match(over!.message, /500Mi/);
    assert.match(over!.message, /20% of request/);
    assert.match(over!.suggested_action!, /150Mi/);  // P95 100 × 1.5
  });

  it('does NOT fire over-provisioned when P95 above floor stays close to request', () => {
    seedK8sHost('node-1');
    seedSnapshot({
      containerName: 'default/api/web',
      memoryRequestMb: 500,
      memoryLimitMb: 1000,
    });
    // 200/500 = 40% → not over-provisioned (threshold is 30%)
    seedBaseline('node-1/default/api/web', 'memory_mb', 200);
    generateInsights(db);
    const insights = getInsights();
    assert.equal(insights.filter(i => i.title.includes('over-provisioned')).length, 0);
  });

  it('does NOT fire below the absolute memory floor (avoids "10× over" on idle workloads)', () => {
    seedK8sHost('node-1');
    seedSnapshot({
      containerName: 'default/idle-app/main',
      memoryRequestMb: 50,
    });
    // 5/50 = 10% — would trigger if not for the 50MB usage floor.
    seedBaseline('node-1/default/idle-app/main', 'memory_mb', 5);
    generateInsights(db);
    assert.equal(getInsights().length, 0);
  });

  // ── Memory under-provisioned ───────────────────────────────────────────────

  it('fires memory under-provisioned (warning) when P95 > 80% of limit', () => {
    seedK8sHost('node-1');
    seedSnapshot({
      containerName: 'default/api/web',
      memoryLimitMb: 100,
      memoryRequestMb: 50,
    });
    // 90/100 = 90%
    seedBaseline('node-1/default/api/web', 'memory_mb', 90);

    generateInsights(db);
    const insights = getInsights();
    const under = insights.find(i => i.title.includes('approaching its memory limit'));
    assert.ok(under, `expected under-provisioned insight, got: ${JSON.stringify(insights)}`);
    assert.equal(under!.severity, 'warning');
    assert.match(under!.message, /90% of limit/);
    assert.match(under!.suggested_action!, /135Mi/);  // 90 × 1.5
  });

  // ── Sample count gate ──────────────────────────────────────────────────────

  it('skips workload when baseline sample_count < 288', () => {
    seedK8sHost('node-1');
    seedSnapshot({
      containerName: 'default/new-app/main',
      memoryRequestMb: 500,
    });
    // Insufficient samples — detector should skip
    seedBaseline('node-1/default/new-app/main', 'memory_mb', 50, /*sampleCount*/ 100);
    generateInsights(db);
    assert.equal(getInsights().length, 0);
  });

  // ── Skips ──────────────────────────────────────────────────────────────────

  it('skips workloads with no requests/limits set', () => {
    seedK8sHost('node-1');
    seedSnapshot({
      containerName: 'default/unconfigured/main',
      // No requests, no limits
    });
    seedBaseline('node-1/default/unconfigured/main', 'memory_mb', 50);
    generateInsights(db);
    assert.equal(getInsights().length, 0);
  });

  it('skips Docker containers (workload_kind IS NULL)', () => {
    seedK8sHost('node-1');
    db.prepare(`
      INSERT INTO container_snapshots
        (host_id, container_name, container_id, status, cpu_percent, memory_mb, restart_count,
         memory_request_mb, memory_limit_mb, workload_kind, collected_at)
      VALUES ('node-1', 'nginx', 'abc', 'running', 5, 50, 0, 500, 1000, NULL, datetime('now'))
    `).run();
    db.prepare("INSERT INTO containers (host_id, container_name, first_seen, last_seen) VALUES ('node-1', 'nginx', datetime('now'), datetime('now'))").run();
    seedBaseline('node-1/nginx', 'memory_mb', 50);
    generateInsights(db);
    assert.equal(getInsights().length, 0);
  });

  it('skips removed containers', () => {
    seedK8sHost('node-1');
    seedSnapshot({
      containerName: 'default/gone/main',
      memoryRequestMb: 500,
    });
    db.prepare("UPDATE containers SET removed_at = datetime('now') WHERE host_id = 'node-1' AND container_name = 'default/gone/main'").run();
    seedBaseline('node-1/default/gone/main', 'memory_mb', 50);
    generateInsights(db);
    assert.equal(getInsights().length, 0);
  });

  // ── Aggregation across replicas ────────────────────────────────────────────

  it('emits ONE workload insight even with multiple replicas', () => {
    seedK8sHost('node-1');
    seedK8sHost('node-2');
    seedSnapshot({ hostId: 'node-1', containerName: 'default/api/web', memoryRequestMb: 500 });
    seedSnapshot({ hostId: 'node-2', containerName: 'default/api/web', memoryRequestMb: 500 });
    seedBaseline('node-1/default/api/web', 'memory_mb', 100);
    seedBaseline('node-2/default/api/web', 'memory_mb', 120);  // worse pod

    generateInsights(db);
    const insights = getInsights().filter(i => i.title.includes('over-provisioned'));
    assert.equal(insights.length, 1);
    // Aggregation takes max — 120 drives the recommendation.
    assert.match(insights[0].message, /120MB/);
    // 24% of 500 = under threshold, so it still fires
    assert.match(insights[0].message, /24% of request/);
  });

  // ── Insightd self-skip ─────────────────────────────────────────────────────

  it('skips insightd-* containers', () => {
    seedK8sHost('node-1');
    seedSnapshot({
      containerName: 'insightd/insightd-agent/agent',
      memoryRequestMb: 500,
    });
    seedBaseline('node-1/insightd/insightd-agent/agent', 'memory_mb', 50);
    generateInsights(db);
    assert.equal(getInsights().length, 0);
  });
});
