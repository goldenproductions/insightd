import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { createTestDb } = require('../helpers/db');
const { suppressConsole } = require('../helpers/mocks');
const { runAnomalyDetection } = require('../../hub/src/insights/anomaly/shesd');

function seedHostRollups(db: any, hostId: string, values: number[], metric: 'cpu_max' | 'mem_used_max' = 'cpu_max'): void {
  const insert = db.prepare(`
    INSERT INTO host_rollups (host_id, bucket, cpu_avg, cpu_max, mem_used_avg, mem_used_max, mem_total, sample_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (let i = 0; i < values.length; i++) {
    const bucket = new Date(Date.now() - (values.length - i) * 3600_000)
      .toISOString()
      .slice(0, 13) + ':00:00';
    const cpuMax = metric === 'cpu_max' ? values[i]! : 10;
    const memMax = metric === 'mem_used_max' ? values[i]! : 500;
    insert.run(hostId, bucket, cpuMax - 1, cpuMax, memMax - 10, memMax, 4000, 12);
  }
}

describe('S-H-ESD anomaly detection', () => {
  let db: any;
  let restore: () => void;

  beforeEach(() => {
    restore = suppressConsole();
    db = createTestDb();
  });

  afterEach(() => {
    restore();
    db.close();
  });

  it('returns 0 detected when series is too short', () => {
    // Need ≥ 168 hourly samples (7 days) — seed only 50.
    seedHostRollups(db, 'h1', Array.from({ length: 50 }, () => 30));
    const detected = runAnomalyDetection(db);
    assert.equal(detected, 0);
  });

  it('detects an injected spike in a flat series', () => {
    // 14 days of hourly samples, flat at 30% CPU with an injected 90% spike.
    const values = Array.from({ length: 336 }, () => 30 + (Math.random() - 0.5) * 2);
    values[200] = 95; // clear outlier
    seedHostRollups(db, 'h1', values);

    const detected = runAnomalyDetection(db);
    assert.ok(detected >= 1, `expected ≥1 anomaly, got ${detected}`);

    const rows = db.prepare(
      "SELECT * FROM rollup_anomalies WHERE entity_type = 'host' AND entity_id = 'h1' AND metric = 'cpu_max'"
    ).all();
    assert.ok(rows.length >= 1);
    // The spike should be the largest-z anomaly.
    const spike = rows.find((r: any) => r.value === 95);
    assert.ok(spike, 'expected a detected row for the 95% spike');
    assert.ok(spike.robust_z >= 3.5, `expected robust_z ≥ 3.5, got ${spike.robust_z}`);
  });

  it('is idempotent — re-running does not duplicate anomalies', () => {
    // Tiny background noise so MAD is non-zero.
    const values = Array.from({ length: 336 }, () => 30 + (Math.random() - 0.5) * 2);
    values[100] = 95;
    seedHostRollups(db, 'h1', values);

    runAnomalyDetection(db);
    runAnomalyDetection(db);

    const rows = db.prepare('SELECT COUNT(*) AS n FROM rollup_anomalies').get() as { n: number };
    // Unique on (entity, metric, bucket) — duplicates should upsert.
    assert.ok(rows.n >= 1);
    const spikes = db.prepare('SELECT COUNT(*) AS n FROM rollup_anomalies WHERE value = 95').get() as { n: number };
    assert.equal(spikes.n, 1);
  });

  it('skips constant series (MAD is zero)', () => {
    const values = Array.from({ length: 336 }, () => 30);
    seedHostRollups(db, 'h1', values);
    const detected = runAnomalyDetection(db);
    assert.equal(detected, 0);
  });
});
