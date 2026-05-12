import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

const { bootstrap, SCHEMA_VERSION } = require('../../hub/src/db/schema');

describe('schema v53 — process_events tables', () => {
  it('bumps SCHEMA_VERSION to 53', () => {
    assert.equal(SCHEMA_VERSION, 53);
  });

  it('creates argv_dictionary and process_events on bootstrap', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    bootstrap(db);
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
    ).all().map((r: any) => r.name);
    assert.ok(tables.includes('argv_dictionary'), 'argv_dictionary missing');
    assert.ok(tables.includes('process_events'), 'process_events missing');
  });

  it('process_events has UNIQUE (host_id, pid, started_at)', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    bootstrap(db);
    db.prepare(
      `INSERT INTO argv_dictionary (argv_hash, argv, comm) VALUES ('h1','/bin/ls','ls')`
    ).run();
    const ins = db.prepare(`
      INSERT INTO process_events
        (host_id, container_id, pod_uid, pid, ppid, argv_hash, started_at, source)
      VALUES (?, NULL, NULL, ?, ?, ?, ?, 'host')
    `);
    ins.run('h', 100, 1, 'h1', '2026-05-12T00:00:00Z');
    assert.throws(() => ins.run('h', 100, 1, 'h1', '2026-05-12T00:00:00Z'),
      /UNIQUE constraint failed/);
  });

  it('migrates from version 52 (cold migrate)', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    bootstrap(db);
    db.prepare(`UPDATE meta SET value='52' WHERE key='schema_version'`).run();
    db.exec('DROP TABLE IF EXISTS argv_dictionary; DROP TABLE IF EXISTS process_events;');
    bootstrap(db);  // should re-create
    const row = db.prepare(
      `SELECT name FROM sqlite_master WHERE name='process_events'`
    ).get();
    assert.ok(row, 'process_events not re-created by migrate');
    const ver = db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as any;
    assert.equal(ver.value, '53');
  });
});
