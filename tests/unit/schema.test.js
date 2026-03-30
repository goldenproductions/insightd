const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootstrap, pruneOldData, SCHEMA_VERSION } = require('../../src/db/schema');
const { suppressConsole } = require('../helpers/mocks');

describe('schema', () => {
  let db;
  let restore;

  beforeEach(() => {
    restore = suppressConsole();
    db = new Database(':memory:');
  });

  it('bootstrap creates all tables', () => {
    bootstrap(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    const names = tables.map(t => t.name);
    assert.ok(names.includes('container_snapshots'));
    assert.ok(names.includes('disk_snapshots'));
    assert.ok(names.includes('update_checks'));
    assert.ok(names.includes('meta'));
    restore();
  });

  it('bootstrap sets schema version', () => {
    bootstrap(db);
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
    assert.equal(row.value, String(SCHEMA_VERSION));
    restore();
  });

  it('bootstrap is idempotent', () => {
    bootstrap(db);
    assert.doesNotThrow(() => bootstrap(db));
    restore();
  });

  it('creates indexes', () => {
    bootstrap(db);
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'").all();
    const names = indexes.map(i => i.name);
    assert.ok(names.includes('idx_snapshots_name_time'));
    assert.ok(names.includes('idx_disk_time'));
    assert.ok(names.includes('idx_updates_name_time'));
    restore();
  });

  describe('pruneOldData', () => {
    it('deletes rows older than 30 days', () => {
      bootstrap(db);
      const old = '2020-01-01 00:00:00';
      const recent = new Date().toISOString().slice(0, 19).replace('T', ' ');

      db.prepare(`INSERT INTO container_snapshots (container_name, container_id, status, collected_at) VALUES (?, ?, ?, ?)`).run('old', 'abc', 'running', old);
      db.prepare(`INSERT INTO container_snapshots (container_name, container_id, status, collected_at) VALUES (?, ?, ?, ?)`).run('recent', 'def', 'running', recent);

      pruneOldData(db);

      const rows = db.prepare('SELECT * FROM container_snapshots').all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].container_name, 'recent');
      restore();
    });

    it('preserves recent data', () => {
      bootstrap(db);
      const recent = new Date().toISOString().slice(0, 19).replace('T', ' ');
      db.prepare(`INSERT INTO container_snapshots (container_name, container_id, status, collected_at) VALUES (?, ?, ?, ?)`).run('test', 'abc', 'running', recent);

      pruneOldData(db);

      const rows = db.prepare('SELECT * FROM container_snapshots').all();
      assert.equal(rows.length, 1);
      restore();
    });
  });
});
