import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
const { bootstrap, SCHEMA_VERSION } = require('../../hub/src/db/schema');

function getColumns(db: any, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(r => r.name);
}

const TLS_COLUMNS = ['tls_expires_at', 'tls_issuer', 'tls_subject_alt_names', 'tls_last_checked_at', 'tls_error'];

describe('schema v39 (TLS cert columns)', () => {
  it('fresh bootstrap has TLS columns on http_endpoints', () => {
    const db = new Database(':memory:');
    bootstrap(db);
    const cols = getColumns(db, 'http_endpoints');
    for (const c of TLS_COLUMNS) {
      assert.ok(cols.includes(c), `http_endpoints has ${c} column`);
    }
    db.close();
  });

  it('migrating from v38 adds the TLS columns', () => {
    const db = new Database(':memory:');
    bootstrap(db);
    // Drop TLS columns to simulate a v38 install, then rewind schema_version.
    db.exec('CREATE TABLE _ep_tmp AS SELECT id, name, url, method, expected_status, interval_seconds, timeout_ms, headers, enabled, source_ingress_id, created_at, updated_at FROM http_endpoints');
    db.exec('DROP TABLE http_endpoints');
    db.exec(`CREATE TABLE http_endpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, url TEXT NOT NULL, method TEXT NOT NULL DEFAULT 'GET',
      expected_status INTEGER NOT NULL DEFAULT 200, interval_seconds INTEGER NOT NULL DEFAULT 60,
      timeout_ms INTEGER NOT NULL DEFAULT 10000, headers TEXT, enabled INTEGER NOT NULL DEFAULT 1,
      source_ingress_id INTEGER REFERENCES k8s_ingresses(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.prepare("UPDATE meta SET value = '38' WHERE key = 'schema_version'").run();
    bootstrap(db);
    const cols = getColumns(db, 'http_endpoints');
    for (const c of TLS_COLUMNS) {
      assert.ok(cols.includes(c), `v38→v40 migration adds ${c}`);
    }
    const v = (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value;
    assert.equal(v, String(SCHEMA_VERSION));
    db.close();
  });
});
