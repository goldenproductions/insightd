import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
const { bootstrap, SCHEMA_VERSION } = require('../../hub/src/db/schema');

function getColumns(db: any, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(r => r.name);
}

describe('schema v44', () => {
  it('reports version 44', () => {
    assert.equal(SCHEMA_VERSION, 44);
  });

  it('fresh bootstrap creates pod_volumes with the expected columns', () => {
    const db = new Database(':memory:');
    bootstrap(db);
    const cols = getColumns(db, 'pod_volumes');
    for (const expected of [
      'cluster_id', 'namespace', 'pod_uid', 'pod_name',
      'volume_name', 'volume_type', 'target_name', 'observed_at',
    ]) {
      assert.ok(cols.includes(expected), `pod_volumes has ${expected}`);
    }
    db.close();
  });

  it('migrating from v43 adds pod_volumes', () => {
    const db = new Database(':memory:');
    bootstrap(db);
    db.exec('DROP TABLE pod_volumes');
    db.prepare("UPDATE meta SET value = '43' WHERE key = 'schema_version'").run();
    bootstrap(db);
    const cols = getColumns(db, 'pod_volumes');
    assert.ok(cols.includes('volume_type'));
    const v = (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value;
    assert.equal(parseInt(v, 10), SCHEMA_VERSION);
    db.close();
  });
});
