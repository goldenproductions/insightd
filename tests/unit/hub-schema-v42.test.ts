import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
const { bootstrap, SCHEMA_VERSION } = require('../../hub/src/db/schema');

function getColumns(db: any, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(r => r.name);
}

describe('schema v42', () => {
  it('fresh bootstrap has the new k8s pod columns on container_snapshots', () => {
    const db = new Database(':memory:');
    bootstrap(db);
    const cols = getColumns(db, 'container_snapshots');
    for (const expected of ['workload_kind', 'pod_ip', 'host_ip', 'pod_conditions']) {
      assert.ok(cols.includes(expected), `container_snapshots has ${expected} column`);
    }
    db.close();
  });

  it('migrating from v41 adds the new columns', () => {
    const db = new Database(':memory:');
    bootstrap(db);
    db.prepare("UPDATE meta SET value = '41' WHERE key = 'schema_version'").run();
    // Drop the new columns to simulate a v41 install. SQLite doesn't support
    // DROP COLUMN in ancient versions, but better-sqlite3 ships a recent one.
    for (const col of ['workload_kind', 'pod_ip', 'host_ip', 'pod_conditions']) {
      try { db.exec(`ALTER TABLE container_snapshots DROP COLUMN ${col}`); } catch { /* best-effort */ }
    }
    bootstrap(db);
    const cols = getColumns(db, 'container_snapshots');
    for (const expected of ['workload_kind', 'pod_ip', 'host_ip', 'pod_conditions']) {
      assert.ok(cols.includes(expected), `${expected} added by migration`);
    }
    const v = (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value;
    assert.equal(parseInt(v, 10), SCHEMA_VERSION);
    db.close();
  });
});
