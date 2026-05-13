import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

const { findActiveParent, findActiveChildren } = require('../../src/alerts/dependencies');

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE hosts (host_id TEXT PRIMARY KEY, proxmox_cluster_id TEXT);
    CREATE TABLE alert_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_type TEXT NOT NULL,
      host_id TEXT NOT NULL,
      target TEXT NOT NULL,
      resolved_at TEXT
    );
  `);
  db.prepare('INSERT INTO hosts (host_id) VALUES (?)').run('h1');
  return db;
}

test('container scope: respawn_loop on container X suppresses high_cpu on same container only', () => {
  const db = freshDb();
  db.prepare('INSERT INTO alert_state (alert_type, host_id, target) VALUES (?,?,?)')
    .run('respawn_loop', 'h1', 'jellyfin');

  const matchSame = findActiveParent(db, { type: 'high_cpu', hostId: 'h1', target: 'jellyfin' });
  assert.ok(matchSame, 'same-container parent should match');
  assert.equal(matchSame.alert_type, 'respawn_loop');

  const matchOther = findActiveParent(db, { type: 'high_cpu', hostId: 'h1', target: 'plex' });
  assert.equal(matchOther, null, 'different-container parent must not match');
});

test('container scope: findActiveChildren filters by target', () => {
  const db = freshDb();
  db.prepare('INSERT INTO alert_state (alert_type, host_id, target) VALUES (?,?,?)')
    .run('high_cpu', 'h1', 'jellyfin');
  db.prepare('INSERT INTO alert_state (alert_type, host_id, target) VALUES (?,?,?)')
    .run('high_cpu', 'h1', 'plex');

  const children = findActiveChildren(db, { alert_type: 'respawn_loop', host_id: 'h1', target: 'jellyfin' });
  const targets = children.map((c: any) => c.target);
  assert.deepEqual(targets, ['jellyfin']);
});
