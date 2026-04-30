import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
const { bootstrap, SCHEMA_VERSION } = require('../../hub/src/db/schema');

function getColumns(db: any, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(r => r.name);
}

describe('schema v45', () => {
  it('fresh bootstrap creates workload_rollouts with the expected columns', () => {
    const db = new Database(':memory:');
    bootstrap(db);
    const cols = getColumns(db, 'workload_rollouts');
    for (const expected of [
      'cluster_id', 'kind', 'namespace', 'name',
      'desired', 'ready', 'updated',
      'generation', 'observed_generation',
      'progress_deadline_exceeded',
      'first_seen_at', 'last_seen_at',
    ]) {
      assert.ok(cols.includes(expected), `workload_rollouts has ${expected}`);
    }
    db.close();
  });

  it('migrating from v44 adds workload_rollouts', () => {
    const db = new Database(':memory:');
    bootstrap(db);
    db.exec('DROP TABLE workload_rollouts');
    db.prepare("UPDATE meta SET value = '44' WHERE key = 'schema_version'").run();
    bootstrap(db);
    const cols = getColumns(db, 'workload_rollouts');
    assert.ok(cols.includes('progress_deadline_exceeded'));
    const v = (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value;
    assert.equal(parseInt(v, 10), SCHEMA_VERSION);
    db.close();
  });
});
