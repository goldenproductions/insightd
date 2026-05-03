import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
const { createTestDb } = require('../helpers/db');
const { getLogPatternsForContainer } = require('../../hub/src/web/queries');

function seedTemplate(db: any, image: string, hash: string, template: string, occ: number, tag: string | null = null): number {
  const r = db.prepare(`
    INSERT INTO log_templates (image, template_hash, template, token_count, semantic_tag, occurrence_count)
    VALUES (?, ?, ?, 4, ?, ?)
  `).run(image, hash, template, tag, occ);
  return Number(r.lastInsertRowid);
}

function seedBurst(db: any, opts: {
  templateId: number; hostId: string; containerName: string; image: string;
  ts: string; batchCount?: number; intensity?: number; tag?: string | null;
}): void {
  db.prepare(`
    INSERT INTO template_burst_events
      (template_id, host_id, container_name, image, ts, batch_count, baseline_rate, intensity, semantic_tag)
    VALUES (?, ?, ?, ?, ?, ?, 0.5, ?, ?)
  `).run(opts.templateId, opts.hostId, opts.containerName, opts.image, opts.ts,
         opts.batchCount ?? 5, opts.intensity ?? 10, opts.tag ?? null);
}

function isoMinutesAgo(n: number): string {
  return new Date(Date.now() - n * 60_000).toISOString().replace('T', ' ').slice(0, 19);
}

describe('getLogPatternsForContainer', () => {
  it('overlays spike summary onto each template', () => {
    const db = createTestDb();
    const t1 = seedTemplate(db, 'web', 'aaaaaaaaaaaaaaaa', 'connection refused at <*>', 100, 'conn_refused');
    seedTemplate(db, 'web', 'bbbbbbbbbbbbbbbb', 'request completed in <*>ms', 5000);

    // Two recent spikes for t1, both within the last hour.
    seedBurst(db, { templateId: t1, hostId: 'h1', containerName: 'web', image: 'web', ts: isoMinutesAgo(10), intensity: 4, batchCount: 3 });
    seedBurst(db, { templateId: t1, hostId: 'h1', containerName: 'web', image: 'web', ts: isoMinutesAgo(2),  intensity: 26, batchCount: 8 });

    const rows = getLogPatternsForContainer(db, 'h1', 'web', 'web');
    assert.equal(rows.length, 2);

    // Row 0: spiking template comes first.
    assert.equal(rows[0].template_hash, 'aaaaaaaaaaaaaaaa');
    assert.equal(rows[0].spike_count, 2);
    assert.equal(rows[0].max_intensity, 26);
    assert.equal(rows[0].latest_batch_count, 8, 'most-recent spike batch_count');
    assert.ok(rows[0].latest_spike_ts);

    // Row 1: non-spiking template still listed, with null spike fields.
    assert.equal(rows[1].template_hash, 'bbbbbbbbbbbbbbbb');
    assert.equal(rows[1].spike_count, null);
    assert.equal(rows[1].max_intensity, null);
    assert.equal(rows[1].latest_spike_ts, null);
    db.close();
  });

  it('does not pull spikes from a different container running the same image', () => {
    const db = createTestDb();
    const t1 = seedTemplate(db, 'web', 'aaaaaaaaaaaaaaaa', 'OOM killed pid <*>', 50, 'oom');

    // Spike on a *different* container — must not appear on this query.
    seedBurst(db, { templateId: t1, hostId: 'h2', containerName: 'other', image: 'web', ts: isoMinutesAgo(5), intensity: 50 });

    const rows = getLogPatternsForContainer(db, 'h1', 'web', 'web');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].spike_count, null, 'sibling container spike does not bleed across');
    db.close();
  });

  it('ignores spikes older than the 1-hour window', () => {
    const db = createTestDb();
    const t1 = seedTemplate(db, 'web', 'aaaaaaaaaaaaaaaa', 'A', 10);
    // 90 minutes ago — outside window.
    const ts90 = new Date(Date.now() - 90 * 60_000).toISOString().replace('T', ' ').slice(0, 19);
    seedBurst(db, { templateId: t1, hostId: 'h1', containerName: 'web', image: 'web', ts: ts90, intensity: 50 });

    const rows = getLogPatternsForContainer(db, 'h1', 'web', 'web');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].spike_count, null);
    db.close();
  });

  it('orders multiple spiking templates by max intensity desc', () => {
    const db = createTestDb();
    const tHi = seedTemplate(db, 'web', 'hihihihihihihihi', 'high spike <*>', 10);
    const tLo = seedTemplate(db, 'web', 'lololololololololo', 'low spike <*>', 999);
    seedBurst(db, { templateId: tHi, hostId: 'h1', containerName: 'web', image: 'web', ts: isoMinutesAgo(5), intensity: 100 });
    seedBurst(db, { templateId: tLo, hostId: 'h1', containerName: 'web', image: 'web', ts: isoMinutesAgo(5), intensity: 3 });

    const rows = getLogPatternsForContainer(db, 'h1', 'web', 'web');
    assert.equal(rows[0].template_hash, 'hihihihihihihihi', 'higher intensity first regardless of lifetime count');
    assert.equal(rows[1].template_hash, 'lololololololololo');
    db.close();
  });
});
