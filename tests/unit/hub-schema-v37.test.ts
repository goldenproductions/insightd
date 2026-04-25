import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
const { bootstrap, SCHEMA_VERSION } = require('../../hub/src/db/schema');

function getColumns(db: any, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(r => r.name);
}

describe('schema v37', () => {
  it('reports version 37', () => {
    assert.equal(SCHEMA_VERSION, 37);
  });

  it('fresh bootstrap has k8s_ingresses + http_endpoints.source_ingress_id', () => {
    const db = new Database(':memory:');
    bootstrap(db);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(r => r.name);
    assert.ok(tables.includes('k8s_ingresses'), 'k8s_ingresses table created on fresh bootstrap');
    const epCols = getColumns(db, 'http_endpoints');
    assert.ok(epCols.includes('source_ingress_id'), 'http_endpoints has source_ingress_id column');
    db.close();
  });

  it('migrating from v36 is idempotent (running bootstrap twice does not error)', () => {
    const db = new Database(':memory:');
    // Simulate a v36 baseline by bootstrapping once, then patching version meta back to 36.
    bootstrap(db);
    db.prepare("UPDATE meta SET value = '36' WHERE key = 'schema_version'").run();
    // Re-run bootstrap — the v37 migration block must succeed against an
    // already-correct schema (CREATE TABLE IF NOT EXISTS + try/catch ALTER).
    bootstrap(db);
    const v = (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value;
    assert.equal(v, '37');
    db.close();
  });
});
