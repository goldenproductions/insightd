const Database = require('better-sqlite3');
const { bootstrap } = require('../../src/db/schema');

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  bootstrap(db);
  return db;
}

function seedContainerSnapshots(db, rows) {
  const insert = db.prepare(`
    INSERT INTO container_snapshots
    (host_id, container_name, container_id, status, cpu_percent, memory_mb, restart_count, collected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const r of rows) {
    insert.run(r.hostId || 'local', r.name, r.id || 'abc123', r.status || 'running', r.cpu ?? null, r.mem ?? null, r.restarts ?? 0, r.at);
  }
}

function seedDiskSnapshots(db, rows) {
  const insert = db.prepare(`
    INSERT INTO disk_snapshots (host_id, mount_point, total_gb, used_gb, used_percent, collected_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const r of rows) {
    insert.run(r.hostId || 'local', r.mount || '/', r.total || 100, r.used || 50, r.percent || 50, r.at);
  }
}

function seedUpdateChecks(db, rows) {
  const insert = db.prepare(`
    INSERT INTO update_checks (host_id, container_name, image, local_digest, remote_digest, has_update, checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const r of rows) {
    insert.run(r.hostId || 'local', r.name, r.image || 'nginx:latest', r.local || 'sha256:aaa', r.remote || 'sha256:bbb', r.hasUpdate ?? 0, r.at);
  }
}

function seedAlertState(db, rows) {
  const insert = db.prepare(`
    INSERT INTO alert_state (host_id, alert_type, target, triggered_at, resolved_at, last_notified, notify_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const r of rows) {
    insert.run(r.hostId || 'local', r.type, r.target, r.triggeredAt, r.resolvedAt || null, r.lastNotified || r.triggeredAt, r.notifyCount ?? 1);
  }
}

module.exports = { createTestDb, seedContainerSnapshots, seedDiskSnapshots, seedUpdateChecks, seedAlertState };
