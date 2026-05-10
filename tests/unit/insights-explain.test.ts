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

  it('placeholder', () => {
    assert.ok(db);
  });
});
