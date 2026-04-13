import type Database from 'better-sqlite3';
import logger = require('../utils/logger');

const SCHEMA_VERSION = 26;

function bootstrap(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS hosts (
      host_id       TEXT PRIMARY KEY,
      first_seen    TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen     TEXT NOT NULL DEFAULT (datetime('now')),
      agent_version TEXT,
      runtime_type  TEXT NOT NULL DEFAULT 'docker',
      host_group    TEXT,
      host_group_override TEXT
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
      health_check_output TEXT,
      labels          TEXT,
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
      gpu_utilization_percent REAL,
      gpu_memory_used_mb  REAL,
      gpu_memory_total_mb REAL,
      gpu_temperature_celsius REAL,
      cpu_temperature_celsius REAL,
      disk_read_bytes_per_sec REAL,
      disk_write_bytes_per_sec REAL,
      net_rx_bytes_per_sec REAL,
      net_tx_bytes_per_sec REAL,
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
      notify_count    INTEGER DEFAULT 1,
      message         TEXT,
      trigger_value   TEXT,
      threshold       TEXT,
      silenced_until  TEXT,
      silenced_by     TEXT,
      silenced_at     TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_alert_host_active
      ON alert_state (host_id, alert_type, target);

    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS http_endpoints (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      name             TEXT NOT NULL,
      url              TEXT NOT NULL,
      method           TEXT NOT NULL DEFAULT 'GET',
      expected_status  INTEGER NOT NULL DEFAULT 200,
      interval_seconds INTEGER NOT NULL DEFAULT 60,
      timeout_ms       INTEGER NOT NULL DEFAULT 10000,
      headers          TEXT,
      enabled          INTEGER NOT NULL DEFAULT 1,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS http_checks (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint_id      INTEGER NOT NULL REFERENCES http_endpoints(id) ON DELETE CASCADE,
      status_code      INTEGER,
      response_time_ms INTEGER,
      is_up            INTEGER NOT NULL,
      error            TEXT,
      checked_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_http_checks_endpoint_time
      ON http_checks (endpoint_id, checked_at);

    CREATE TABLE IF NOT EXISTS service_groups (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL UNIQUE,
      description TEXT,
      icon        TEXT,
      color       TEXT,
      source      TEXT NOT NULL DEFAULT 'manual',
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS service_group_members (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id        INTEGER NOT NULL REFERENCES service_groups(id) ON DELETE CASCADE,
      host_id         TEXT NOT NULL,
      container_name  TEXT NOT NULL,
      source          TEXT NOT NULL DEFAULT 'manual',
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(group_id, host_id, container_name)
    );

    CREATE INDEX IF NOT EXISTS idx_group_members_container
      ON service_group_members (host_id, container_name);

    CREATE TABLE IF NOT EXISTS baselines (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type      TEXT NOT NULL,
      entity_id        TEXT NOT NULL,
      metric           TEXT NOT NULL,
      time_bucket      TEXT NOT NULL,
      p50              REAL,
      p75              REAL,
      p90              REAL,
      p95              REAL,
      p99              REAL,
      min_val          REAL,
      max_val          REAL,
      mad              REAL,
      mad_sample_count INTEGER,
      sample_count     INTEGER NOT NULL DEFAULT 0,
      computed_at      TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(entity_type, entity_id, metric, time_bucket)
    );

    CREATE INDEX IF NOT EXISTS idx_baselines_entity
      ON baselines (entity_type, entity_id);

    CREATE TABLE IF NOT EXISTS health_scores (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type  TEXT NOT NULL,
      entity_id    TEXT NOT NULL,
      score        INTEGER NOT NULL,
      factors      TEXT NOT NULL,
      computed_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(entity_type, entity_id)
    );

    CREATE TABLE IF NOT EXISTS insights (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type   TEXT NOT NULL,
      entity_id     TEXT NOT NULL,
      category      TEXT NOT NULL,
      severity      TEXT NOT NULL,
      title         TEXT NOT NULL,
      message       TEXT NOT NULL,
      metric        TEXT,
      current_value REAL,
      baseline_value REAL,
      evidence      TEXT,
      suggested_action TEXT,
      confidence    TEXT,
      computed_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_insights_entity
      ON insights (entity_type, entity_id);

    CREATE TABLE IF NOT EXISTS insight_feedback (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type  TEXT NOT NULL,
      entity_id    TEXT NOT NULL,
      category     TEXT NOT NULL,
      metric       TEXT,
      helpful      INTEGER NOT NULL,
      diagnoser    TEXT,
      finding_hash TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(entity_type, entity_id, category, metric)
    );

    CREATE TABLE IF NOT EXISTS confidence_calibration (
      diagnoser       TEXT NOT NULL,
      conclusion_tag  TEXT NOT NULL,
      helpful_count   INTEGER NOT NULL DEFAULT 0,
      unhelpful_count INTEGER NOT NULL DEFAULT 0,
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (diagnoser, conclusion_tag)
    );

    CREATE TABLE IF NOT EXISTS ai_diagnoses (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id         TEXT NOT NULL,
      container_name  TEXT NOT NULL,
      context_hash    TEXT NOT NULL,
      model           TEXT NOT NULL,
      root_cause      TEXT NOT NULL,
      reasoning       TEXT NOT NULL,
      suggested_fix   TEXT NOT NULL,
      confidence      REAL,
      caveats         TEXT,
      prompt_tokens   INTEGER,
      response_tokens INTEGER,
      latency_ms      INTEGER,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_ai_diagnoses_container
      ON ai_diagnoses (host_id, container_name, created_at DESC);

    CREATE TABLE IF NOT EXISTS log_templates (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      image            TEXT NOT NULL,
      template_hash    TEXT NOT NULL,
      template         TEXT NOT NULL,
      token_count      INTEGER NOT NULL,
      semantic_tag     TEXT,
      first_seen       TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen        TEXT NOT NULL DEFAULT (datetime('now')),
      occurrence_count INTEGER NOT NULL DEFAULT 1,
      UNIQUE(image, template_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_log_templates_image
      ON log_templates (image, last_seen);

    CREATE TABLE IF NOT EXISTS webhooks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      type        TEXT NOT NULL,
      url         TEXT NOT NULL,
      secret      TEXT,
      on_alert    INTEGER NOT NULL DEFAULT 1,
      on_digest   INTEGER NOT NULL DEFAULT 1,
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,
      key_prefix   TEXT NOT NULL,
      key_hash     TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_collected ON container_snapshots (collected_at);

    CREATE TABLE IF NOT EXISTS host_rollups (
      host_id        TEXT NOT NULL,
      bucket         TEXT NOT NULL,
      cpu_avg        REAL, cpu_max REAL,
      mem_used_avg   REAL, mem_used_max REAL, mem_total REAL,
      load_1_avg     REAL, load_1_max REAL,
      swap_used_avg  REAL,
      gpu_util_avg   REAL, cpu_temp_avg REAL,
      disk_read_avg  REAL, disk_write_avg REAL,
      net_rx_avg     REAL, net_tx_avg REAL,
      sample_count   INTEGER NOT NULL,
      PRIMARY KEY (host_id, bucket)
    );

    CREATE TABLE IF NOT EXISTS container_rollups (
      host_id         TEXT NOT NULL,
      container_name  TEXT NOT NULL,
      bucket          TEXT NOT NULL,
      status_running  INTEGER,
      status_total    INTEGER,
      cpu_avg         REAL, cpu_max REAL,
      mem_avg         REAL, mem_max REAL,
      net_rx_bytes    INTEGER, net_tx_bytes INTEGER,
      restart_count   INTEGER,
      sample_count    INTEGER NOT NULL,
      PRIMARY KEY (host_id, container_name, bucket)
    );

    CREATE TABLE IF NOT EXISTS disk_rollups (
      host_id       TEXT NOT NULL,
      mount_point   TEXT NOT NULL,
      bucket        TEXT NOT NULL,
      used_avg      REAL, used_max REAL,
      total_gb      REAL,
      sample_count  INTEGER NOT NULL,
      PRIMARY KEY (host_id, mount_point, bucket)
    );

    CREATE TABLE IF NOT EXISTS http_rollups (
      endpoint_id     INTEGER NOT NULL,
      bucket          TEXT NOT NULL,
      response_avg_ms INTEGER, response_max_ms INTEGER,
      up_count        INTEGER, total_count INTEGER,
      sample_count    INTEGER NOT NULL,
      PRIMARY KEY (endpoint_id, bucket)
    );

    CREATE TABLE IF NOT EXISTS rollup_anomalies (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type  TEXT NOT NULL,
      entity_id    TEXT NOT NULL,
      metric       TEXT NOT NULL,
      bucket       TEXT NOT NULL,
      value        REAL NOT NULL,
      residual     REAL NOT NULL,
      robust_z     REAL NOT NULL,
      detected_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(entity_type, entity_id, metric, bucket)
    );

    CREATE INDEX IF NOT EXISTS idx_rollup_anomalies_entity
      ON rollup_anomalies (entity_type, entity_id, detected_at);

    CREATE TABLE IF NOT EXISTS rca_edges (
      from_entity  TEXT NOT NULL,
      to_entity    TEXT NOT NULL,
      edge_type    TEXT NOT NULL,
      weight       REAL NOT NULL,
      computed_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (from_entity, to_entity, edge_type)
    );

    CREATE INDEX IF NOT EXISTS idx_rca_edges_from ON rca_edges(from_entity);
  `);

  // Track schema version and run migrations
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string } | undefined;
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

function migrate(db: Database.Database, fromVersion: number): void {
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
  if (fromVersion < 6) {
    // http_endpoints and http_checks tables are created via CREATE TABLE IF NOT EXISTS in bootstrap
  }
  if (fromVersion < 7) {
    // webhooks table is created via CREATE TABLE IF NOT EXISTS in bootstrap
  }
  if (fromVersion < 8) {
    try {
      db.exec('ALTER TABLE container_snapshots ADD COLUMN labels TEXT');
    } catch {
      // Column already exists
    }
    // service_groups and service_group_members tables created via CREATE TABLE IF NOT EXISTS in bootstrap
  }
  if (fromVersion < 9) {
    const newCols = [
      'gpu_utilization_percent REAL', 'gpu_memory_used_mb REAL', 'gpu_memory_total_mb REAL',
      'gpu_temperature_celsius REAL', 'cpu_temperature_celsius REAL',
      'disk_read_bytes_per_sec REAL', 'disk_write_bytes_per_sec REAL',
      'net_rx_bytes_per_sec REAL', 'net_tx_bytes_per_sec REAL',
    ];
    for (const col of newCols) {
      try { db.exec(`ALTER TABLE host_snapshots ADD COLUMN ${col}`); } catch { /* already exists */ }
    }
  }
  if (fromVersion < 10) {
    // baselines, health_scores, insights tables created via CREATE TABLE IF NOT EXISTS in bootstrap
  }
  if (fromVersion < 11) {
    try { db.exec('ALTER TABLE hosts ADD COLUMN agent_version TEXT'); } catch { /* already exists */ }
  }
  if (fromVersion < 12) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_collected ON container_snapshots (collected_at);
    `);
  }
  if (fromVersion < 13) {
    try { db.exec('ALTER TABLE alert_state ADD COLUMN message TEXT'); } catch { /* already exists */ }
    try { db.exec('ALTER TABLE alert_state ADD COLUMN trigger_value TEXT'); } catch { /* already exists */ }
    try { db.exec('ALTER TABLE alert_state ADD COLUMN threshold TEXT'); } catch { /* already exists */ }
  }
  if (fromVersion < 14) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS insight_feedback (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type  TEXT NOT NULL,
        entity_id    TEXT NOT NULL,
        category     TEXT NOT NULL,
        metric       TEXT,
        helpful      INTEGER NOT NULL,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(entity_type, entity_id, category, metric)
      );
    `);
  }
  if (fromVersion < 15) {
    try { db.exec("ALTER TABLE hosts ADD COLUMN runtime_type TEXT NOT NULL DEFAULT 'docker'"); } catch { /* already exists */ }
  }
  if (fromVersion < 16) {
    try { db.exec('ALTER TABLE hosts ADD COLUMN host_group TEXT'); } catch { /* already exists */ }
  }
  if (fromVersion < 17) {
    try { db.exec('ALTER TABLE hosts ADD COLUMN host_group_override TEXT'); } catch { /* already exists */ }
  }
  if (fromVersion < 18) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS host_rollups (
        host_id TEXT NOT NULL, bucket TEXT NOT NULL,
        cpu_avg REAL, cpu_max REAL, mem_used_avg REAL, mem_used_max REAL, mem_total REAL,
        load_1_avg REAL, load_1_max REAL, swap_used_avg REAL,
        gpu_util_avg REAL, cpu_temp_avg REAL,
        disk_read_avg REAL, disk_write_avg REAL, net_rx_avg REAL, net_tx_avg REAL,
        sample_count INTEGER NOT NULL, PRIMARY KEY (host_id, bucket)
      );
      CREATE TABLE IF NOT EXISTS container_rollups (
        host_id TEXT NOT NULL, container_name TEXT NOT NULL, bucket TEXT NOT NULL,
        status_running INTEGER, status_total INTEGER,
        cpu_avg REAL, cpu_max REAL, mem_avg REAL, mem_max REAL,
        net_rx_bytes INTEGER, net_tx_bytes INTEGER, restart_count INTEGER,
        sample_count INTEGER NOT NULL, PRIMARY KEY (host_id, container_name, bucket)
      );
      CREATE TABLE IF NOT EXISTS disk_rollups (
        host_id TEXT NOT NULL, mount_point TEXT NOT NULL, bucket TEXT NOT NULL,
        used_avg REAL, used_max REAL, total_gb REAL,
        sample_count INTEGER NOT NULL, PRIMARY KEY (host_id, mount_point, bucket)
      );
      CREATE TABLE IF NOT EXISTS http_rollups (
        endpoint_id INTEGER NOT NULL, bucket TEXT NOT NULL,
        response_avg_ms INTEGER, response_max_ms INTEGER,
        up_count INTEGER, total_count INTEGER,
        sample_count INTEGER NOT NULL, PRIMARY KEY (endpoint_id, bucket)
      );
    `);
  }
  if (fromVersion < 19) {
    try { db.exec('ALTER TABLE container_snapshots ADD COLUMN health_check_output TEXT'); } catch { /* already exists */ }
  }
  if (fromVersion < 20) {
    try { db.exec('ALTER TABLE insights ADD COLUMN evidence TEXT'); } catch { /* already exists */ }
    try { db.exec('ALTER TABLE insights ADD COLUMN suggested_action TEXT'); } catch { /* already exists */ }
    try { db.exec('ALTER TABLE insights ADD COLUMN confidence TEXT'); } catch { /* already exists */ }
  }
  if (fromVersion < 21) {
    // ai_diagnoses table created via CREATE TABLE IF NOT EXISTS in bootstrap
  }
  if (fromVersion < 22) {
    try { db.exec('ALTER TABLE alert_state ADD COLUMN silenced_until TEXT'); } catch { /* already exists */ }
    try { db.exec('ALTER TABLE alert_state ADD COLUMN silenced_by TEXT'); } catch { /* already exists */ }
    try { db.exec('ALTER TABLE alert_state ADD COLUMN silenced_at TEXT'); } catch { /* already exists */ }
  }
  if (fromVersion < 23) {
    // log_templates table + index created via CREATE TABLE IF NOT EXISTS in bootstrap
  }
  if (fromVersion < 24) {
    try { db.exec('ALTER TABLE baselines ADD COLUMN mad REAL'); } catch { /* already exists */ }
    try { db.exec('ALTER TABLE baselines ADD COLUMN mad_sample_count INTEGER'); } catch { /* already exists */ }
    // rollup_anomalies table + index created via CREATE TABLE IF NOT EXISTS in bootstrap
  }
  if (fromVersion < 25) {
    // rca_edges table + index created via CREATE TABLE IF NOT EXISTS in bootstrap
  }
  if (fromVersion < 26) {
    try { db.exec('ALTER TABLE insight_feedback ADD COLUMN diagnoser TEXT'); } catch { /* already exists */ }
    try { db.exec('ALTER TABLE insight_feedback ADD COLUMN finding_hash TEXT'); } catch { /* already exists */ }
    // confidence_calibration table created via CREATE TABLE IF NOT EXISTS in bootstrap
  }
}

/**
 * Roll up raw data into hourly summaries, then delete old data.
 * @param rawDays — days to keep raw snapshots (default 30, min 7)
 * @param rollupDays — days to keep hourly rollups (default 365, min 30)
 */
function pruneOldData(db: Database.Database, rawDays: number = 30, rollupDays: number = 365): void {
  const { computeRollups, getMetaValue, setMetaValue } = require('./rollups') as {
    computeRollups: (db: Database.Database) => void;
    getMetaValue: (db: Database.Database, key: string) => string | null;
    setMetaValue: (db: Database.Database, key: string, value: string) => void;
  };

  // 1. Roll up any un-rolled-up data before deleting
  computeRollups(db);

  // 2. Delete raw data older than rawDays
  const rawCutoff = `datetime('now', '-${Math.max(7, rawDays)} days')`;
  const r1 = db.prepare(`DELETE FROM container_snapshots WHERE collected_at < ${rawCutoff}`).run();
  const r2 = db.prepare(`DELETE FROM disk_snapshots WHERE collected_at < ${rawCutoff}`).run();
  const r3 = db.prepare(`DELETE FROM update_checks WHERE checked_at < ${rawCutoff}`).run();
  const r4 = db.prepare(`DELETE FROM alert_state WHERE resolved_at IS NOT NULL AND resolved_at < ${rawCutoff}`).run();
  const r5 = db.prepare(`DELETE FROM host_snapshots WHERE collected_at < ${rawCutoff}`).run();
  const r7 = db.prepare(`DELETE FROM http_checks WHERE checked_at < ${rawCutoff}`).run();
  const r8 = db.prepare(`DELETE FROM insight_feedback WHERE created_at < ${rawCutoff}`).run();
  const r6 = db.prepare(`DELETE FROM hosts WHERE host_id NOT IN (
    SELECT DISTINCT host_id FROM container_snapshots WHERE collected_at >= ${rawCutoff}
    UNION SELECT DISTINCT host_id FROM host_snapshots WHERE collected_at >= ${rawCutoff}
  )`).run();

  // 3. Delete rollups older than rollupDays
  const rollupCutoff = `datetime('now', '-${Math.max(30, rollupDays)} days')`;
  const r9 = db.prepare(`DELETE FROM host_rollups WHERE bucket < ${rollupCutoff}`).run();
  const r10 = db.prepare(`DELETE FROM container_rollups WHERE bucket < ${rollupCutoff}`).run();
  const r11 = db.prepare(`DELETE FROM disk_rollups WHERE bucket < ${rollupCutoff}`).run();
  const r12 = db.prepare(`DELETE FROM http_rollups WHERE bucket < ${rollupCutoff}`).run();

  const total = r1.changes + r2.changes + r3.changes + r4.changes + r5.changes
    + r6.changes + r7.changes + r8.changes + r9.changes + r10.changes + r11.changes + r12.changes;

  if (total > 0) {
    logger.info('schema', `Pruned ${total} rows (raw >${rawDays}d, rollups >${rollupDays}d)`);
  }

  // 4. Update prune timestamp
  setMetaValue(db, 'last_prune_at', new Date().toISOString().slice(0, 19).replace('T', ' '));

  // 5. Conditional VACUUM: only if >10k rows deleted and last vacuum >7 days ago
  if (total > 10000) {
    const lastVacuum = getMetaValue(db, 'last_vacuum_at');
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
    if (!lastVacuum || lastVacuum < weekAgo) {
      db.exec('VACUUM');
      setMetaValue(db, 'last_vacuum_at', new Date().toISOString().slice(0, 19).replace('T', ' '));
      logger.info('schema', 'Database vacuumed');
    }
  }
}

module.exports = { bootstrap, pruneOldData, SCHEMA_VERSION };
