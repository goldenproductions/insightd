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
    (host_id, container_name, container_id, status, cpu_percent, memory_mb, restart_count, network_rx_bytes, network_tx_bytes, blkio_read_bytes, blkio_write_bytes, health_status, collected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const r of rows) {
    insert.run(r.hostId || 'local', r.name, r.id || 'abc123', r.status || 'running', r.cpu ?? null, r.mem ?? null, r.restarts ?? 0,
      r.netRx ?? null, r.netTx ?? null, r.blkRead ?? null, r.blkWrite ?? null, r.health ?? null, r.at);
  }
}

function seedHostSnapshots(db, rows) {
  const insert = db.prepare(`
    INSERT INTO host_snapshots
    (host_id, cpu_percent, memory_total_mb, memory_used_mb, memory_available_mb, swap_total_mb, swap_used_mb, load_1, load_5, load_15, uptime_seconds, collected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const r of rows) {
    insert.run(r.hostId || 'local', r.cpu ?? null, r.memTotal ?? null, r.memUsed ?? null, r.memAvail ?? null,
      r.swapTotal ?? 0, r.swapUsed ?? 0, r.load1 ?? null, r.load5 ?? null, r.load15 ?? null, r.uptime ?? null, r.at);
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

function seedHttpEndpoints(db, rows) {
  const insert = db.prepare(`
    INSERT INTO http_endpoints (name, url, method, expected_status, interval_seconds, timeout_ms, headers, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const ids = [];
  for (const r of rows) {
    const result = insert.run(r.name, r.url, r.method || 'GET', r.expectedStatus || 200,
      r.intervalSeconds || 60, r.timeoutMs || 10000, r.headers || null, r.enabled !== false ? 1 : 0);
    ids.push(result.lastInsertRowid);
  }
  return ids;
}

function seedHttpChecks(db, rows) {
  const insert = db.prepare(`
    INSERT INTO http_checks (endpoint_id, status_code, response_time_ms, is_up, error, checked_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const r of rows) {
    insert.run(r.endpointId, r.statusCode ?? null, r.responseTimeMs ?? null, r.isUp ? 1 : 0, r.error || null, r.at);
  }
}

function seedWebhooks(db, rows) {
  const insert = db.prepare(`
    INSERT INTO webhooks (name, type, url, secret, on_alert, on_digest, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const ids = [];
  for (const r of rows) {
    const result = insert.run(r.name, r.type, r.url, r.secret || null,
      r.onAlert !== false ? 1 : 0, r.onDigest !== false ? 1 : 0, r.enabled !== false ? 1 : 0);
    ids.push(result.lastInsertRowid);
  }
  return ids;
}

function seedServiceGroups(db, rows) {
  const insert = db.prepare('INSERT INTO service_groups (name, description, icon, color, source) VALUES (?, ?, ?, ?, ?)');
  const ids = [];
  for (const r of rows) {
    const result = insert.run(r.name, r.description || null, r.icon || null, r.color || null, r.source || 'manual');
    ids.push(result.lastInsertRowid);
  }
  return ids;
}

function seedGroupMembers(db, rows) {
  const insert = db.prepare('INSERT INTO service_group_members (group_id, host_id, container_name, source) VALUES (?, ?, ?, ?)');
  for (const r of rows) {
    insert.run(r.groupId, r.hostId || 'local', r.containerName, r.source || 'manual');
  }
}

module.exports = { createTestDb, seedContainerSnapshots, seedDiskSnapshots, seedUpdateChecks, seedAlertState, seedHostSnapshots, seedHttpEndpoints, seedHttpChecks, seedWebhooks, seedServiceGroups, seedGroupMembers };
