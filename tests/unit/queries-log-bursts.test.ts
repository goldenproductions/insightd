import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
const { createTestDb } = require('../helpers/db');
const { getLogBursts } = require('../../hub/src/web/queries');

function seedTemplate(db: any, image: string, hash: string, template: string): number {
  const r = db.prepare(`
    INSERT INTO log_templates (image, template_hash, template, token_count, occurrence_count)
    VALUES (?, ?, ?, 3, 100)
  `).run(image, hash, template);
  return Number(r.lastInsertRowid);
}

function seedBurst(db: any, opts: {
  templateId: number; hostId: string; containerName: string; image: string;
  ts: string; batchCount?: number; baselineRate?: number; intensity?: number; tag?: string | null;
}) {
  db.prepare(`
    INSERT INTO template_burst_events
      (template_id, host_id, container_name, image, ts, batch_count, baseline_rate, intensity, semantic_tag)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(opts.templateId, opts.hostId, opts.containerName, opts.image, opts.ts,
         opts.batchCount ?? 5, opts.baselineRate ?? 0.5, opts.intensity ?? 10,
         opts.tag ?? null);
}

function isoMinutesAgo(n: number): string {
  return new Date(Date.now() - n * 60_000).toISOString();
}

describe('getLogBursts', () => {
  it('joins log_templates + filters by host/container and time window', () => {
    const db = createTestDb();
    const tid = seedTemplate(db, 'myimg', 'aaaa', 'connection refused <*>');
    seedBurst(db, { templateId: tid, hostId: 'h1', containerName: 'c1', image: 'myimg',
      ts: isoMinutesAgo(5).replace('T', ' ').slice(0, 19), tag: 'conn_refused' });

    // Outside window (2 hours ago, with 1h window centered on now)
    seedBurst(db, { templateId: tid, hostId: 'h1', containerName: 'c1', image: 'myimg',
      ts: isoMinutesAgo(120).replace('T', ' ').slice(0, 19) });

    // Different container
    seedBurst(db, { templateId: tid, hostId: 'h1', containerName: 'cOther', image: 'myimg',
      ts: isoMinutesAgo(5).replace('T', ' ').slice(0, 19) });

    const rows = getLogBursts(db, 'h1', 'c1', new Date().toISOString(), 60 * 60 * 1000);
    assert.equal(rows.length, 1, 'only the in-window row for c1 returned');
    assert.equal(rows[0].template, 'connection refused <*>');
    assert.equal(rows[0].semantic_tag, 'conn_refused');
    db.close();
  });

  it('returns empty list for invalid center timestamp', () => {
    const db = createTestDb();
    const rows = getLogBursts(db, 'h1', 'c1', 'not-a-date', 3600_000);
    assert.deepEqual(rows, []);
    db.close();
  });

  it('orders newest-first', () => {
    const db = createTestDb();
    const tid = seedTemplate(db, 'myimg', 'aaaa', 'A');
    seedBurst(db, { templateId: tid, hostId: 'h1', containerName: 'c1', image: 'myimg',
      ts: isoMinutesAgo(20).replace('T', ' ').slice(0, 19), batchCount: 3 });
    seedBurst(db, { templateId: tid, hostId: 'h1', containerName: 'c1', image: 'myimg',
      ts: isoMinutesAgo(5).replace('T', ' ').slice(0, 19), batchCount: 9 });
    const rows = getLogBursts(db, 'h1', 'c1', new Date().toISOString(), 3600_000);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].batch_count, 9, 'most recent first');
    assert.equal(rows[1].batch_count, 3);
    db.close();
  });
});
