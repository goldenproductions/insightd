import Database = require('better-sqlite3');

const { bootstrap } = require('../../src/db/schema') as { bootstrap: (db: Database.Database) => void };

interface ContainerSnapshotSeed {
  hostId?: string; name: string; id?: string; status?: string;
  cpu?: number | null; mem?: number | null; restarts?: number;
  netRx?: number | null; netTx?: number | null;
  blkRead?: number | null; blkWrite?: number | null;
  health?: string | null; at: string;
  // When true, skip upserting into the `containers` registry — use this to
  // simulate a container that has been removed (Docker rm, k8s pod delete)
  // but whose historical snapshots are still in the DB.
  removed?: boolean;
}

interface ContainerRegistrySeed {
  hostId?: string; name: string;
  firstSeen?: string; lastSeen?: string; removedAt?: string | null;
}

interface HostSnapshotSeed {
  hostId?: string; cpu?: number | null;
  memTotal?: number | null; memUsed?: number | null; memAvail?: number | null;
  swapTotal?: number; swapUsed?: number;
  load1?: number | null; load5?: number | null; load15?: number | null;
  uptime?: number | null; at: string;
}

interface DiskSnapshotSeed {
  hostId?: string; mount?: string; total?: number; used?: number; percent?: number; at: string;
}

interface UpdateCheckSeed {
  hostId?: string; name: string; image?: string; local?: string; remote?: string; hasUpdate?: number; at: string;
}

interface AlertStateSeed {
  hostId?: string; type: string; target: string; triggeredAt: string;
  resolvedAt?: string | null; lastNotified?: string | null; notifyCount?: number;
  silencedUntil?: string | null;
}

interface HttpEndpointSeed {
  name: string; url: string; method?: string; expectedStatus?: number;
  intervalSeconds?: number; timeoutMs?: number; headers?: string | null; enabled?: boolean;
}

interface HttpCheckSeed {
  endpointId: number | bigint; statusCode?: number | null; responseTimeMs?: number | null;
  isUp: boolean; error?: string | null; at: string;
}

interface WebhookSeed {
  name: string; type: string; url: string; secret?: string | null;
  onAlert?: boolean; onDigest?: boolean; enabled?: boolean;
}

interface ServiceGroupSeed {
  name: string; description?: string | null; icon?: string | null; color?: string | null; source?: string;
}

interface GroupMemberSeed {
  groupId: number | bigint; hostId?: string; containerName: string; source?: string;
}

interface BaselineSeed {
  entityType: string; entityId: string; metric?: string; timeBucket?: string;
  p50?: number; p75?: number; p90?: number; p95?: number; p99?: number;
  min?: number; max?: number; sampleCount?: number;
}

interface HealthScoreSeed {
  entityType: string; entityId: string; score?: number; factors?: string;
}

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  bootstrap(db);
  return db;
}

function seedContainerSnapshots(db: Database.Database, rows: ContainerSnapshotSeed[]): void {
  const insert = db.prepare(`
    INSERT INTO container_snapshots
    (host_id, container_name, container_id, status, cpu_percent, memory_mb, restart_count, network_rx_bytes, network_tx_bytes, blkio_read_bytes, blkio_write_bytes, health_status, collected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // Production ingest always pairs snapshot inserts with a registry upsert.
  // Mirror that here so tests that call seedContainerSnapshots get a live
  // `containers` row for free — otherwise every query that joins the
  // registry returns empty. Pass `removed: true` on a seed row to simulate
  // a container whose last snapshot is frozen but whose registry row is
  // either absent or marked removed_at.
  const upsert = db.prepare(`
    INSERT INTO containers (host_id, container_name, first_seen, last_seen, removed_at)
    VALUES (?, ?, ?, ?, NULL)
    ON CONFLICT(host_id, container_name) DO UPDATE SET
      last_seen = MAX(containers.last_seen, excluded.last_seen),
      first_seen = MIN(containers.first_seen, excluded.first_seen),
      removed_at = NULL
  `);
  for (const r of rows) {
    const hostId = r.hostId || 'local';
    insert.run(hostId, r.name, r.id || 'abc123', r.status || 'running', r.cpu ?? null, r.mem ?? null, r.restarts ?? 0,
      r.netRx ?? null, r.netTx ?? null, r.blkRead ?? null, r.blkWrite ?? null, r.health ?? null, r.at);
    if (!r.removed) {
      upsert.run(hostId, r.name, r.at, r.at);
    }
  }
}

function seedContainers(db: Database.Database, rows: ContainerRegistrySeed[]): void {
  const insert = db.prepare(`
    INSERT INTO containers (host_id, container_name, first_seen, last_seen, removed_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(host_id, container_name) DO UPDATE SET
      first_seen = excluded.first_seen,
      last_seen = excluded.last_seen,
      removed_at = excluded.removed_at
  `);
  for (const r of rows) {
    const at = r.lastSeen || r.firstSeen || "datetime('now')";
    insert.run(r.hostId || 'local', r.name, r.firstSeen || at, r.lastSeen || at, r.removedAt ?? null);
  }
}

function markContainerRemoved(db: Database.Database, hostId: string, name: string, removedAt?: string): void {
  db.prepare("UPDATE containers SET removed_at = ? WHERE host_id = ? AND container_name = ?")
    .run(removedAt || new Date().toISOString().slice(0, 19).replace('T', ' '), hostId, name);
}

function seedHostSnapshots(db: Database.Database, rows: HostSnapshotSeed[]): void {
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

function seedDiskSnapshots(db: Database.Database, rows: DiskSnapshotSeed[]): void {
  const insert = db.prepare(`
    INSERT INTO disk_snapshots (host_id, mount_point, total_gb, used_gb, used_percent, collected_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const r of rows) {
    insert.run(r.hostId || 'local', r.mount || '/', r.total || 100, r.used || 50, r.percent || 50, r.at);
  }
}

function seedUpdateChecks(db: Database.Database, rows: UpdateCheckSeed[]): void {
  const insert = db.prepare(`
    INSERT INTO update_checks (host_id, container_name, image, local_digest, remote_digest, has_update, checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const r of rows) {
    insert.run(r.hostId || 'local', r.name, r.image || 'nginx:latest', r.local || 'sha256:aaa', r.remote || 'sha256:bbb', r.hasUpdate ?? 0, r.at);
  }
}

function seedAlertState(db: Database.Database, rows: AlertStateSeed[]): void {
  const insert = db.prepare(`
    INSERT INTO alert_state (host_id, alert_type, target, triggered_at, resolved_at, last_notified, notify_count, silenced_until)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const r of rows) {
    insert.run(r.hostId || 'local', r.type, r.target, r.triggeredAt, r.resolvedAt || null, r.lastNotified || r.triggeredAt, r.notifyCount ?? 1, r.silencedUntil ?? null);
  }
}

function seedHttpEndpoints(db: Database.Database, rows: HttpEndpointSeed[]): (number | bigint)[] {
  const insert = db.prepare(`
    INSERT INTO http_endpoints (name, url, method, expected_status, interval_seconds, timeout_ms, headers, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const ids: (number | bigint)[] = [];
  for (const r of rows) {
    const result = insert.run(r.name, r.url, r.method || 'GET', r.expectedStatus || 200,
      r.intervalSeconds || 60, r.timeoutMs || 10000, r.headers || null, r.enabled !== false ? 1 : 0);
    ids.push(result.lastInsertRowid);
  }
  return ids;
}

function seedHttpChecks(db: Database.Database, rows: HttpCheckSeed[]): void {
  const insert = db.prepare(`
    INSERT INTO http_checks (endpoint_id, status_code, response_time_ms, is_up, error, checked_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const r of rows) {
    insert.run(r.endpointId, r.statusCode ?? null, r.responseTimeMs ?? null, r.isUp ? 1 : 0, r.error || null, r.at);
  }
}

function seedWebhooks(db: Database.Database, rows: WebhookSeed[]): (number | bigint)[] {
  const insert = db.prepare(`
    INSERT INTO webhooks (name, type, url, secret, on_alert, on_digest, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const ids: (number | bigint)[] = [];
  for (const r of rows) {
    const result = insert.run(r.name, r.type, r.url, r.secret || null,
      r.onAlert !== false ? 1 : 0, r.onDigest !== false ? 1 : 0, r.enabled !== false ? 1 : 0);
    ids.push(result.lastInsertRowid);
  }
  return ids;
}

function seedServiceGroups(db: Database.Database, rows: ServiceGroupSeed[]): (number | bigint)[] {
  const insert = db.prepare('INSERT INTO service_groups (name, description, icon, color, source) VALUES (?, ?, ?, ?, ?)');
  const ids: (number | bigint)[] = [];
  for (const r of rows) {
    const result = insert.run(r.name, r.description || null, r.icon || null, r.color || null, r.source || 'manual');
    ids.push(result.lastInsertRowid);
  }
  return ids;
}

function seedGroupMembers(db: Database.Database, rows: GroupMemberSeed[]): void {
  const insert = db.prepare('INSERT INTO service_group_members (group_id, host_id, container_name, source) VALUES (?, ?, ?, ?)');
  for (const r of rows) {
    insert.run(r.groupId, r.hostId || 'local', r.containerName, r.source || 'manual');
  }
}

function seedBaselines(db: Database.Database, rows: BaselineSeed[]): void {
  const insert = db.prepare(`
    INSERT INTO baselines (entity_type, entity_id, metric, time_bucket, p50, p75, p90, p95, p99, min_val, max_val, sample_count, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  for (const r of rows) {
    insert.run(r.entityType, r.entityId, r.metric || 'cpu_percent', r.timeBucket || 'all',
      r.p50 ?? 10, r.p75 ?? 20, r.p90 ?? 30, r.p95 ?? 40, r.p99 ?? 50, r.min ?? 1, r.max ?? 60, r.sampleCount ?? 100);
  }
}

function seedHealthScores(db: Database.Database, rows: HealthScoreSeed[]): void {
  const insert = db.prepare(`
    INSERT INTO health_scores (entity_type, entity_id, score, factors, computed_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(entity_type, entity_id) DO UPDATE SET score=excluded.score, factors=excluded.factors
  `);
  for (const r of rows) {
    insert.run(r.entityType, r.entityId, r.score ?? 85, r.factors || '{}');
  }
}

module.exports = { createTestDb, seedContainerSnapshots, seedContainers, markContainerRemoved, seedDiskSnapshots, seedUpdateChecks, seedAlertState, seedHostSnapshots, seedHttpEndpoints, seedHttpChecks, seedWebhooks, seedServiceGroups, seedGroupMembers, seedBaselines, seedHealthScores };
