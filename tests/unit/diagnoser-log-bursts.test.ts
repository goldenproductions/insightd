import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const { createTestDb, seedContainerSnapshots, seedHostSnapshots, seedBaselines } = require('../helpers/db');
const { suppressConsole } = require('../helpers/mocks');
const { runDiagnosis } = require('../../hub/src/insights/diagnosis/run');
const { _clearCache } = require('../../hub/src/insights/diagnosis/logCache');
const { _clearStickyCache } = require('../../hub/src/insights/diagnosis/sticky');

function ts(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function seedTemplate(db: any, image: string, hash: string, template: string, tag: string | null = null): number {
  const r = db.prepare(`
    INSERT INTO log_templates (image, template_hash, template, token_count, semantic_tag, occurrence_count)
    VALUES (?, ?, ?, 4, ?, 50)
  `).run(image, hash, template, tag);
  return Number(r.lastInsertRowid);
}

function seedBurst(db: any, opts: {
  templateId: number; hostId: string; containerName: string; image: string;
  ts: string; batchCount?: number; baselineRate?: number; intensity?: number; tag?: string | null;
}): void {
  db.prepare(`
    INSERT INTO template_burst_events
      (template_id, host_id, container_name, image, ts, batch_count, baseline_rate, intensity, semantic_tag)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(opts.templateId, opts.hostId, opts.containerName, opts.image, opts.ts,
         opts.batchCount ?? 5, opts.baselineRate ?? 0.5, opts.intensity ?? 10, opts.tag ?? null);
}

describe('diagnoser → log burst evidence', () => {
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

  it('attaches recent template_burst_events as Finding.logBursts', () => {
    seedContainerSnapshots(db, [
      { hostId: 'h1', name: 'leaky', health: 'unhealthy', cpu: 5, mem: 700, at: ts(new Date(NOW - 60_000)) },
    ]);
    // History to trigger oom_risk: rising memory + baseline.
    for (let i = 10; i >= 1; i--) {
      seedContainerSnapshots(db, [{
        hostId: 'h1', name: 'leaky', health: 'healthy',
        cpu: 5, mem: 200 + (10 - i) * 50,
        at: ts(new Date(NOW - i * 10 * 60_000)),
      }]);
    }
    seedHostSnapshots(db, [{ hostId: 'h1', cpu: 30, memTotal: 16000, memUsed: 4000, load1: 1, at: ts(new Date(NOW - 60_000)) }]);
    seedBaselines(db, [{ entityType: 'container', entityId: 'h1/leaky', metric: 'memory_mb', p50: 250, p95: 400 }]);

    const tid = seedTemplate(db, 'leaky', 'aaaaaaaaaaaaaaaa', 'OOM killed pid <*>', 'oom');
    seedBurst(db, {
      templateId: tid, hostId: 'h1', containerName: 'leaky', image: 'leaky',
      ts: ts(new Date(NOW - 5 * 60_000)),
      batchCount: 4, baselineRate: 0.05, intensity: 80, tag: 'oom',
    });

    const findings = runDiagnosis(db, { type: 'container', hostId: 'h1', containerName: 'leaky' });
    assert.equal(findings.length, 1, 'one finding emitted');
    const f = findings[0];
    assert.ok(f.logBursts, 'finding has logBursts attached');
    assert.equal(f.logBursts.length, 1);
    assert.equal(f.logBursts[0].template, 'OOM killed pid <*>');
    assert.equal(f.logBursts[0].semantic_tag, 'oom');
    assert.equal(f.logBursts[0].batch_count, 4);
    assert.equal(f.logBursts[0].intensity, 80);
  });

  it('omits logBursts when no recent bursts on this entity', () => {
    seedContainerSnapshots(db, [
      { hostId: 'h1', name: 'web', health: 'unhealthy', cpu: 5, mem: 100, at: ts(new Date(NOW - 60_000)) },
    ]);
    seedHostSnapshots(db, [{ hostId: 'h1', cpu: 92, memTotal: 16000, memUsed: 4000, load1: 10, at: ts(new Date(NOW - 60_000)) }]);

    const findings = runDiagnosis(db, { type: 'container', hostId: 'h1', containerName: 'web' });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].logBursts, undefined, 'logBursts is undefined when no bursts');
  });

  it('persists rich {lines, log_bursts} JSON when bursts are present', () => {
    seedContainerSnapshots(db, [
      { hostId: 'h1', name: 'web', health: 'unhealthy', cpu: 5, mem: 100, at: ts(new Date(NOW - 60_000)) },
    ]);
    seedHostSnapshots(db, [{ hostId: 'h1', cpu: 92, memTotal: 16000, memUsed: 4000, load1: 10, at: ts(new Date(NOW - 60_000)) }]);
    const tid = seedTemplate(db, 'web', 'bbbbbbbbbbbbbbbb', 'connection refused at <*>', 'conn_refused');
    seedBurst(db, {
      templateId: tid, hostId: 'h1', containerName: 'web', image: 'web',
      ts: ts(new Date(NOW - 2 * 60_000)),
      batchCount: 3, baselineRate: 0.1, intensity: 30, tag: 'conn_refused',
    });

    runDiagnosis(db, { type: 'container', hostId: 'h1', containerName: 'web' }, { persistCategory: 'health' });

    const row = db.prepare(`
      SELECT evidence FROM insights WHERE entity_id = 'h1/web' AND category = 'health'
    `).get() as { evidence: string };
    assert.ok(row, 'finding persisted');
    const parsed = JSON.parse(row.evidence);
    assert.ok(!Array.isArray(parsed), 'rich shape, not legacy array');
    assert.ok(Array.isArray(parsed.lines), 'lines is an array of strings');
    assert.ok(Array.isArray(parsed.log_bursts), 'log_bursts attached');
    assert.equal(parsed.log_bursts.length, 1);
    assert.equal(parsed.log_bursts[0].template, 'connection refused at <*>');
    assert.equal(parsed.log_bursts[0].semantic_tag, 'conn_refused');
  });

  it('persists legacy array shape when there are no bursts', () => {
    seedContainerSnapshots(db, [
      { hostId: 'h1', name: 'web', health: 'unhealthy', cpu: 5, mem: 100, at: ts(new Date(NOW - 60_000)) },
    ]);
    seedHostSnapshots(db, [{ hostId: 'h1', cpu: 92, memTotal: 16000, memUsed: 4000, load1: 10, at: ts(new Date(NOW - 60_000)) }]);

    runDiagnosis(db, { type: 'container', hostId: 'h1', containerName: 'web' }, { persistCategory: 'health' });

    const row = db.prepare(`
      SELECT evidence FROM insights WHERE entity_id = 'h1/web' AND category = 'health'
    `).get() as { evidence: string };
    const parsed = JSON.parse(row.evidence);
    assert.ok(Array.isArray(parsed), 'legacy array shape preserved when no bursts');
  });
});
