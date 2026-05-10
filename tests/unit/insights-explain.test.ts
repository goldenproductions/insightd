import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { createTestDb } = require('../helpers/db');
const { suppressConsole } = require('../helpers/mocks');

const explain = require('../../hub/src/insights/explain');

function tsAt(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function seedInsight(db: any, opts: {
  id?: number; entity_type: string; entity_id: string; category: string;
  severity?: string; title?: string; message?: string;
  metric?: string | null; current_value?: number | null; baseline_value?: number | null;
  evidence?: string | null; suggested_action?: string | null;
  confidence?: 'high' | 'medium' | 'low' | null;
  computed_at: string;
}) {
  const stmt = db.prepare(`
    INSERT INTO insights (id, entity_type, entity_id, category, severity, title, message,
      metric, current_value, baseline_value, evidence, suggested_action, confidence, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    opts.id ?? null,
    opts.entity_type, opts.entity_id, opts.category,
    opts.severity ?? 'warning',
    opts.title ?? 'test',
    opts.message ?? 'msg',
    opts.metric ?? null,
    opts.current_value ?? null,
    opts.baseline_value ?? null,
    opts.evidence ?? null,
    opts.suggested_action ?? null,
    opts.confidence ?? null,
    opts.computed_at,
  );
  return db.prepare('SELECT * FROM insights WHERE rowid = last_insert_rowid()').get();
}

describe('insights explain', () => {
  let db: any;
  let restore: () => void;
  const NOW = new Date('2026-05-10T12:00:00Z');

  beforeEach(() => {
    restore = suppressConsole();
    db = createTestDb();
  });

  afterEach(() => {
    restore();
    db.close();
  });

  describe('buildSummary', () => {
    it('synthesizes a summary for a capacity-based performance insight', () => {
      const insight = seedInsight(db, {
        entity_type: 'host', entity_id: 'h1',
        category: 'performance', metric: 'host.cpu_percent',
        title: 'High CPU on h1', message: 'CPU at 92%',
        current_value: 92, baseline_value: 70,
        confidence: 'medium', computed_at: tsAt(NOW),
      });

      const summary = explain.buildSummary(insight);

      assert.equal(summary.confidence, 'medium');
      assert.match(summary.lead, /h1/);
      assert.ok(summary.reasons.length >= 1, 'expected at least one reason');
      assert.ok(
        summary.reasons.some((r: string) => r.includes('92')),
        `expected current value in reasons; got ${JSON.stringify(summary.reasons)}`,
      );
    });

    it('preserves diagnosis-engine evidence order when present', () => {
      const evidenceObj = {
        lines: ['OOM kills detected in last 30m', 'Memory above 95% for 3h', 'Restart loop pattern'],
        log_bursts: [],
      };
      const insight = seedInsight(db, {
        entity_type: 'container', entity_id: 'h1/api',
        category: 'health', title: 'Container unhealthy', message: 'fails health check',
        evidence: JSON.stringify(evidenceObj), confidence: 'high',
        computed_at: tsAt(NOW),
      });

      const summary = explain.buildSummary(insight);

      assert.deepEqual(summary.reasons, evidenceObj.lines);
      assert.equal(summary.confidence, 'high');
    });

    it('tolerates legacy string-array evidence shape', () => {
      const insight = seedInsight(db, {
        entity_type: 'host', entity_id: 'h1', category: 'health',
        title: 't', message: 'm',
        evidence: JSON.stringify(['legacy reason 1', 'legacy reason 2']),
        computed_at: tsAt(NOW),
      });

      const summary = explain.buildSummary(insight);

      assert.deepEqual(summary.reasons, ['legacy reason 1', 'legacy reason 2']);
    });

    it('falls back to synthesis when evidence JSON is malformed', () => {
      const insight = seedInsight(db, {
        entity_type: 'host', entity_id: 'h1', category: 'performance',
        metric: 'host.cpu_percent', current_value: 80,
        evidence: 'not-json',
        title: 't', message: 'm', computed_at: tsAt(NOW),
      });

      const summary = explain.buildSummary(insight);

      assert.ok(summary.reasons.some((r: string) => r.includes('80')));
    });
  });
});
