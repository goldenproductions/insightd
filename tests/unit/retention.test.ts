import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
const Database = require('better-sqlite3');
const { bootstrap, pruneOldData } = require('../../hub/src/db/schema');
const { computeRollups, getMetaValue, setMetaValue } = require('../../hub/src/db/rollups');
const { suppressConsole } = require('../helpers/mocks');

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 19).replace('T', ' ');
}

function hoursAgo(n: number): string {
  return new Date(Date.now() - n * 3600000).toISOString().slice(0, 19).replace('T', ' ');
}

describe('retention', () => {
  let db: any;
  let restore: () => void;

  beforeEach(() => {
    restore = suppressConsole();
    db = new Database(':memory:');
    bootstrap(db);
  });

  describe('rollup tables created', () => {
    it('schema v18 creates rollup tables', () => {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
      const names = tables.map((t: any) => t.name);
      assert.ok(names.includes('host_rollups'));
      assert.ok(names.includes('container_rollups'));
      assert.ok(names.includes('disk_rollups'));
      assert.ok(names.includes('http_rollups'));
      restore();
    });
  });

  describe('computeRollups', () => {
    it('aggregates host snapshots into hourly buckets', () => {
      const ts1 = hoursAgo(5).replace(/:\d\d$/, ':00');
      const ts2 = hoursAgo(5).replace(/:\d\d$/, ':05');

      db.prepare('INSERT INTO host_snapshots (host_id, cpu_percent, memory_used_mb, memory_total_mb, load_1, collected_at) VALUES (?, ?, ?, ?, ?, ?)').run('h1', 40, 1000, 4000, 2.0, ts1);
      db.prepare('INSERT INTO host_snapshots (host_id, cpu_percent, memory_used_mb, memory_total_mb, load_1, collected_at) VALUES (?, ?, ?, ?, ?, ?)').run('h1', 60, 2000, 4000, 4.0, ts2);

      computeRollups(db);

      const rollups = db.prepare('SELECT * FROM host_rollups WHERE host_id = ?').all('h1');
      assert.ok(rollups.length >= 1);
      const r = rollups[0];
      assert.equal(r.sample_count, 2);
      assert.equal(r.cpu_avg, 50); // (40+60)/2
      assert.equal(r.cpu_max, 60);
      assert.equal(r.load_1_max, 4.0);
      restore();
    });

    it('aggregates container snapshots', () => {
      const ts = hoursAgo(5).replace(/:\d\d$/, ':10');
      db.prepare('INSERT INTO container_snapshots (host_id, container_name, container_id, status, cpu_percent, memory_mb, collected_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('h1', 'web', 'abc', 'running', 25, 512, ts);
      db.prepare('INSERT INTO container_snapshots (host_id, container_name, container_id, status, cpu_percent, memory_mb, collected_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('h1', 'web', 'abc', 'running', 75, 768, ts);

      computeRollups(db);

      const rollups = db.prepare('SELECT * FROM container_rollups WHERE container_name = ?').all('web');
      assert.ok(rollups.length >= 1);
      assert.equal(rollups[0].cpu_avg, 50);
      assert.equal(rollups[0].cpu_max, 75);
      assert.equal(rollups[0].status_running, 2);
      restore();
    });

    it('is idempotent — running twice produces same result', () => {
      const ts = hoursAgo(5).replace(/:\d\d$/, ':15');
      db.prepare('INSERT INTO host_snapshots (host_id, cpu_percent, collected_at) VALUES (?, ?, ?)').run('h1', 50, ts);

      computeRollups(db);
      const count1 = db.prepare('SELECT COUNT(*) as c FROM host_rollups').get().c;

      // Reset last_rollup_at to force re-processing
      setMetaValue(db, 'last_rollup_at', hoursAgo(10));
      computeRollups(db);
      const count2 = db.prepare('SELECT COUNT(*) as c FROM host_rollups').get().c;

      assert.equal(count1, count2); // INSERT OR IGNORE prevents duplicates
      restore();
    });

    it('updates last_rollup_at in meta', () => {
      const ts = hoursAgo(5).replace(/:\d\d$/, ':20');
      db.prepare('INSERT INTO host_snapshots (host_id, cpu_percent, collected_at) VALUES (?, ?, ?)').run('h1', 50, ts);

      computeRollups(db);

      const val = getMetaValue(db, 'last_rollup_at');
      assert.ok(val !== null);
      restore();
    });
  });

  describe('pruneOldData with configurable retention', () => {
    it('respects custom rawDays parameter', () => {
      const old15 = daysAgo(15);
      const recent = daysAgo(1);
      db.prepare('INSERT INTO container_snapshots (container_name, container_id, status, collected_at) VALUES (?, ?, ?, ?)').run('old', 'abc', 'running', old15);
      db.prepare('INSERT INTO container_snapshots (container_name, container_id, status, collected_at) VALUES (?, ?, ?, ?)').run('recent', 'def', 'running', recent);

      pruneOldData(db, 10); // keep 10 days → 15-day-old row gets deleted

      const rows = db.prepare('SELECT * FROM container_snapshots').all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].container_name, 'recent');
      restore();
    });

    it('enforces minimum 7 days for rawDays', () => {
      const fiveDaysOld = daysAgo(5);
      db.prepare('INSERT INTO container_snapshots (container_name, container_id, status, collected_at) VALUES (?, ?, ?, ?)').run('test', 'abc', 'running', fiveDaysOld);

      pruneOldData(db, 1); // tries 1 day, but min is 7

      const rows = db.prepare('SELECT * FROM container_snapshots').all();
      assert.equal(rows.length, 1); // 5-day-old data survives because min is 7
      restore();
    });

    it('prunes insight_feedback', () => {
      const old = daysAgo(40);
      const recent = daysAgo(1);
      db.prepare('INSERT INTO insight_feedback (entity_type, entity_id, category, helpful, created_at) VALUES (?, ?, ?, ?, ?)').run('host', 'h1', 'trend', 1, old);
      db.prepare('INSERT INTO insight_feedback (entity_type, entity_id, category, metric, helpful, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('host', 'h2', 'trend', 'cpu', 1, recent);

      pruneOldData(db, 30);

      const rows = db.prepare('SELECT * FROM insight_feedback').all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].entity_id, 'h2');
      restore();
    });

    it('prunes old rollup data based on rollupDays', () => {
      db.prepare('INSERT INTO host_rollups (host_id, bucket, cpu_avg, sample_count) VALUES (?, ?, ?, ?)').run('h1', daysAgo(400), 50, 12);
      db.prepare('INSERT INTO host_rollups (host_id, bucket, cpu_avg, sample_count) VALUES (?, ?, ?, ?)').run('h1', daysAgo(10), 60, 12);

      pruneOldData(db, 30, 365);

      const rows = db.prepare('SELECT * FROM host_rollups').all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].cpu_avg, 60);
      restore();
    });

    it('rollup data survives raw prune', () => {
      // Insert raw data that's old enough to be pruned
      const old = daysAgo(35);
      db.prepare('INSERT INTO host_snapshots (host_id, cpu_percent, collected_at) VALUES (?, ?, ?)').run('h1', 50, old);

      // Insert rollup for same period — should survive
      db.prepare('INSERT INTO host_rollups (host_id, bucket, cpu_avg, sample_count) VALUES (?, ?, ?, ?)').run('h1', old, 50, 12);

      pruneOldData(db, 30, 365);

      // Raw data pruned
      const rawRows = db.prepare('SELECT * FROM host_snapshots').all();
      assert.equal(rawRows.length, 0);

      // Rollup survives (only 35 days old, rollupDays=365)
      const rollupRows = db.prepare('SELECT * FROM host_rollups').all();
      assert.equal(rollupRows.length, 1);
      restore();
    });

    it('updates last_prune_at in meta', () => {
      pruneOldData(db, 30);
      const val = getMetaValue(db, 'last_prune_at');
      assert.ok(val !== null);
      restore();
    });
  });

  describe('meta helpers', () => {
    it('getMetaValue returns null for missing keys', () => {
      assert.equal(getMetaValue(db, 'nonexistent'), null);
      restore();
    });

    it('setMetaValue creates and updates', () => {
      setMetaValue(db, 'test_key', 'value1');
      assert.equal(getMetaValue(db, 'test_key'), 'value1');

      setMetaValue(db, 'test_key', 'value2');
      assert.equal(getMetaValue(db, 'test_key'), 'value2');
      restore();
    });
  });
});
