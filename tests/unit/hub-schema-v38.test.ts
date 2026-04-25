import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
const { bootstrap, SCHEMA_VERSION } = require('../../hub/src/db/schema');

function getColumns(db: any, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(r => r.name);
}

describe('schema v38', () => {
  it('reports version 38', () => {
    assert.equal(SCHEMA_VERSION, 38);
  });

  it('fresh bootstrap has k8s_ingresses + http_endpoints.source_ingress_id + dismissed_at', () => {
    const db = new Database(':memory:');
    bootstrap(db);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(r => r.name);
    assert.ok(tables.includes('k8s_ingresses'), 'k8s_ingresses table created on fresh bootstrap');
    const epCols = getColumns(db, 'http_endpoints');
    assert.ok(epCols.includes('source_ingress_id'), 'http_endpoints has source_ingress_id column');
    const ingCols = getColumns(db, 'k8s_ingresses');
    assert.ok(ingCols.includes('dismissed_at'), 'k8s_ingresses has dismissed_at column');
    db.close();
  });

  it('migrating from v37 (k8s_ingresses present, dismissed_at absent) adds the column', () => {
    const db = new Database(':memory:');
    bootstrap(db);
    // Drop the v38-only column, then drop schema_version back to 37 to
    // simulate an install that ran v37 before this migration existed.
    db.exec('CREATE TABLE _ki_tmp AS SELECT id, cluster_id, namespace, name, ingress_class, hosts, paths, tls_hosts, external_ip, created_at, labels, observed_at, removed_at FROM k8s_ingresses');
    db.exec('DROP TABLE k8s_ingresses');
    db.exec(`CREATE TABLE k8s_ingresses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cluster_id TEXT NOT NULL, namespace TEXT NOT NULL, name TEXT NOT NULL,
      ingress_class TEXT, hosts TEXT NOT NULL, paths TEXT NOT NULL, tls_hosts TEXT,
      external_ip TEXT, created_at TEXT, labels TEXT,
      observed_at TEXT NOT NULL DEFAULT (datetime('now')), removed_at TEXT,
      UNIQUE(cluster_id, namespace, name)
    )`);
    db.prepare("UPDATE meta SET value = '37' WHERE key = 'schema_version'").run();
    bootstrap(db);
    const ingCols = getColumns(db, 'k8s_ingresses');
    assert.ok(ingCols.includes('dismissed_at'), 'v37→v38 migration adds dismissed_at');
    const v = (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value;
    assert.equal(v, '38');
    db.close();
  });
});
