const logger = require('../utils/logger');

const SCHEMA_VERSION = 2;

function bootstrap(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS container_snapshots (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      container_name  TEXT NOT NULL,
      container_id    TEXT NOT NULL,
      status          TEXT NOT NULL,
      cpu_percent     REAL,
      memory_mb       REAL,
      restart_count   INTEGER DEFAULT 0,
      collected_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_name_time
      ON container_snapshots (container_name, collected_at);

    CREATE TABLE IF NOT EXISTS disk_snapshots (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      mount_point   TEXT NOT NULL,
      total_gb      REAL NOT NULL,
      used_gb       REAL NOT NULL,
      used_percent  REAL NOT NULL,
      collected_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_disk_time
      ON disk_snapshots (collected_at);

    CREATE TABLE IF NOT EXISTS update_checks (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      container_name  TEXT NOT NULL,
      image           TEXT NOT NULL,
      local_digest    TEXT,
      remote_digest   TEXT,
      has_update      INTEGER DEFAULT 0,
      checked_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_updates_name_time
      ON update_checks (container_name, checked_at);

    CREATE TABLE IF NOT EXISTS alert_state (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_type      TEXT NOT NULL,
      target          TEXT NOT NULL,
      triggered_at    TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at     TEXT,
      last_notified   TEXT NOT NULL DEFAULT (datetime('now')),
      notify_count    INTEGER DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_alert_active
      ON alert_state (alert_type, target);
  `);

  // Track schema version and run migrations
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
  if (!row) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
    logger.info('schema', `Database bootstrapped at schema version ${SCHEMA_VERSION}`);
  } else {
    const currentVersion = parseInt(row.value, 10);
    if (currentVersion < SCHEMA_VERSION) {
      // Migrations are handled by CREATE TABLE IF NOT EXISTS above
      db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(SCHEMA_VERSION), 'schema_version');
      logger.info('schema', `Database migrated from version ${currentVersion} to ${SCHEMA_VERSION}`);
    } else {
      logger.info('schema', `Database at schema version ${row.value}`);
    }
  }
}

/**
 * Delete data older than 30 days to keep the DB small.
 */
function pruneOldData(db) {
  const cutoff = "datetime('now', '-30 days')";
  const r1 = db.prepare(`DELETE FROM container_snapshots WHERE collected_at < ${cutoff}`).run();
  const r2 = db.prepare(`DELETE FROM disk_snapshots WHERE collected_at < ${cutoff}`).run();
  const r3 = db.prepare(`DELETE FROM update_checks WHERE checked_at < ${cutoff}`).run();
  const r4 = db.prepare(`DELETE FROM alert_state WHERE resolved_at IS NOT NULL AND resolved_at < ${cutoff}`).run();
  const total = r1.changes + r2.changes + r3.changes + r4.changes;
  if (total > 0) {
    logger.info('schema', `Pruned ${total} rows older than 30 days`);
  }
}

module.exports = { bootstrap, pruneOldData, SCHEMA_VERSION };
