const logger = require('../../../shared/utils/logger');

const SCHEMA_VERSION = 5;

function bootstrap(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS hosts (
      host_id    TEXT PRIMARY KEY,
      first_seen TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS container_snapshots (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id         TEXT NOT NULL DEFAULT 'local',
      container_name  TEXT NOT NULL,
      container_id    TEXT NOT NULL,
      status          TEXT NOT NULL,
      cpu_percent     REAL,
      memory_mb       REAL,
      restart_count   INTEGER DEFAULT 0,
      network_rx_bytes INTEGER,
      network_tx_bytes INTEGER,
      blkio_read_bytes INTEGER,
      blkio_write_bytes INTEGER,
      health_status   TEXT,
      collected_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_host_name_time
      ON container_snapshots (host_id, container_name, collected_at);

    CREATE TABLE IF NOT EXISTS host_snapshots (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id             TEXT NOT NULL,
      cpu_percent         REAL,
      memory_total_mb     REAL,
      memory_used_mb      REAL,
      memory_available_mb REAL,
      swap_total_mb       REAL,
      swap_used_mb        REAL,
      load_1              REAL,
      load_5              REAL,
      load_15             REAL,
      uptime_seconds      REAL,
      collected_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_host_snapshots_host_time
      ON host_snapshots (host_id, collected_at);

    CREATE TABLE IF NOT EXISTS disk_snapshots (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id       TEXT NOT NULL DEFAULT 'local',
      mount_point   TEXT NOT NULL,
      total_gb      REAL NOT NULL,
      used_gb       REAL NOT NULL,
      used_percent  REAL NOT NULL,
      collected_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_disk_host_time
      ON disk_snapshots (host_id, collected_at);

    CREATE TABLE IF NOT EXISTS update_checks (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id         TEXT NOT NULL DEFAULT 'local',
      container_name  TEXT NOT NULL,
      image           TEXT NOT NULL,
      local_digest    TEXT,
      remote_digest   TEXT,
      has_update      INTEGER DEFAULT 0,
      checked_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_updates_host_name_time
      ON update_checks (host_id, container_name, checked_at);

    CREATE TABLE IF NOT EXISTS alert_state (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id         TEXT NOT NULL DEFAULT 'local',
      alert_type      TEXT NOT NULL,
      target          TEXT NOT NULL,
      triggered_at    TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at     TEXT,
      last_notified   TEXT NOT NULL DEFAULT (datetime('now')),
      notify_count    INTEGER DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_alert_host_active
      ON alert_state (host_id, alert_type, target);

    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Track schema version and run migrations
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
  if (!row) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
    logger.info('schema', `Database bootstrapped at schema version ${SCHEMA_VERSION}`);
  } else {
    const currentVersion = parseInt(row.value, 10);
    if (currentVersion < SCHEMA_VERSION) {
      migrate(db, currentVersion);
      db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(SCHEMA_VERSION), 'schema_version');
      logger.info('schema', `Database migrated from version ${currentVersion} to ${SCHEMA_VERSION}`);
    } else {
      logger.info('schema', `Database at schema version ${row.value}`);
    }
  }
}

function migrate(db, fromVersion) {
  if (fromVersion < 3) {
    // Add host_id to existing tables (DEFAULT 'local' for existing rows)
    const tables = [
      { table: 'container_snapshots', col: 'host_id' },
      { table: 'disk_snapshots', col: 'host_id' },
      { table: 'update_checks', col: 'host_id' },
      { table: 'alert_state', col: 'host_id' },
    ];
    for (const { table, col } of tables) {
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT NOT NULL DEFAULT 'local'`);
      } catch {
        // Column already exists
      }
    }
  }
  if (fromVersion < 4) {
    // Add new container telemetry columns
    const newCols = [
      'network_rx_bytes INTEGER',
      'network_tx_bytes INTEGER',
      'blkio_read_bytes INTEGER',
      'blkio_write_bytes INTEGER',
      'health_status TEXT',
    ];
    for (const col of newCols) {
      try {
        db.exec(`ALTER TABLE container_snapshots ADD COLUMN ${col}`);
      } catch {
        // Column already exists (fresh DB)
      }
    }
    // host_snapshots table is created via CREATE TABLE IF NOT EXISTS in bootstrap
  }
  if (fromVersion < 5) {
    // settings table is created via CREATE TABLE IF NOT EXISTS in bootstrap
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
  const r5 = db.prepare(`DELETE FROM host_snapshots WHERE collected_at < ${cutoff}`).run();
  const r6 = db.prepare(`DELETE FROM hosts WHERE host_id NOT IN (
    SELECT DISTINCT host_id FROM container_snapshots WHERE collected_at >= ${cutoff}
    UNION SELECT DISTINCT host_id FROM host_snapshots WHERE collected_at >= ${cutoff}
  )`).run();
  const total = r1.changes + r2.changes + r3.changes + r4.changes + r5.changes + r6.changes;
  if (total > 0) {
    logger.info('schema', `Pruned ${total} rows older than 30 days`);
  }
}

module.exports = { bootstrap, pruneOldData, SCHEMA_VERSION };
