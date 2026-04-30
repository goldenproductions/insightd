import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
const { bootstrap, SCHEMA_VERSION } = require('../../hub/src/db/schema');

function getColumns(db: any, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(r => r.name);
}

describe('schema v41', () => {
  it('fresh bootstrap creates pending_pods', () => {
    const db = new Database(':memory:');
    bootstrap(db);
    const cols = getColumns(db, 'pending_pods');
    assert.deepEqual(
      cols.sort(),
      ['cluster_id', 'first_seen_at', 'last_seen_at', 'message', 'namespace',
       'pod_created_at', 'pod_name', 'pod_phase', 'reason', 'workload_kind', 'workload_name'].sort(),
    );
    db.close();
  });

  it('migrating from v40 adds the table', () => {
    const db = new Database(':memory:');
    bootstrap(db);
    db.exec('DROP TABLE pending_pods');
    db.prepare("UPDATE meta SET value = '40' WHERE key = 'schema_version'").run();
    bootstrap(db);
    const cols = getColumns(db, 'pending_pods');
    assert.ok(cols.includes('cluster_id'));
    assert.ok(cols.includes('first_seen_at'));
    const v = (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value;
    assert.equal(parseInt(v, 10), SCHEMA_VERSION);
    db.close();
  });
});
