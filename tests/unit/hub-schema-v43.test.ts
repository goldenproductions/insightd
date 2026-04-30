import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
const { bootstrap, SCHEMA_VERSION } = require('../../hub/src/db/schema');

function getColumns(db: any, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(r => r.name);
}

describe('schema v43', () => {
  it('fresh bootstrap creates k8s_services with the expected columns', () => {
    const db = new Database(':memory:');
    bootstrap(db);
    const cols = getColumns(db, 'k8s_services');
    for (const expected of [
      'cluster_id', 'namespace', 'name', 'type', 'cluster_ip', 'external_ips',
      'external_name', 'selector', 'ports', 'created_at', 'labels',
      'observed_at', 'removed_at',
    ]) {
      assert.ok(cols.includes(expected), `k8s_services has ${expected}`);
    }
    db.close();
  });

  it('migrating from v42 adds k8s_services', () => {
    const db = new Database(':memory:');
    bootstrap(db);
    db.exec('DROP TABLE k8s_services');
    db.prepare("UPDATE meta SET value = '42' WHERE key = 'schema_version'").run();
    bootstrap(db);
    const cols = getColumns(db, 'k8s_services');
    assert.ok(cols.includes('selector'));
    const v = (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value;
    assert.equal(parseInt(v, 10), SCHEMA_VERSION);
    db.close();
  });
});
