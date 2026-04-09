import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const { createTestDb } = require('../helpers/db');

const { ingestContainers, ingestDisk, ingestUpdates, upsertHost, ingestHost } = require('../../hub/src/ingest') as {
  ingestContainers: (db: any, hostId: string, containers: any[]) => void;
  ingestDisk: (db: any, hostId: string, disk: any[]) => void;
  ingestUpdates: (db: any, hostId: string, updates: any[]) => void;
  upsertHost: (db: any, hostId: string, agentVersion?: string | null, runtimeType?: string, hostGroup?: string | null) => void;
  ingestHost: (db: any, hostId: string, hostData: any) => void;
};

describe('hub ingest', () => {
  let db: any;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  describe('ingestContainers', () => {
    it('inserts container snapshots with all fields', () => {
      ingestContainers(db, 'h1', [{
        name: 'nginx',
        id: 'abc123',
        status: 'running',
        cpuPercent: 12.5,
        memoryMb: 256,
        restartCount: 0,
        networkRxBytes: 1024,
        networkTxBytes: 2048,
        blkioReadBytes: 4096,
        blkioWriteBytes: 8192,
        healthStatus: 'healthy',
        labels: { app: 'web' },
      }]);

      const row = db.prepare('SELECT * FROM container_snapshots WHERE host_id = ?').get('h1');
      assert.equal(row.container_name, 'nginx');
      assert.equal(row.container_id, 'abc123');
      assert.equal(row.status, 'running');
      assert.equal(row.cpu_percent, 12.5);
      assert.equal(row.memory_mb, 256);
      assert.equal(row.restart_count, 0);
      assert.equal(row.network_rx_bytes, 1024);
      assert.equal(row.network_tx_bytes, 2048);
      assert.equal(row.blkio_read_bytes, 4096);
      assert.equal(row.blkio_write_bytes, 8192);
      assert.equal(row.health_status, 'healthy');
      assert.equal(row.labels, '{"app":"web"}');
    });

    it('coerces undefined optional fields to NULL', () => {
      ingestContainers(db, 'h1', [{
        name: 'minimal',
        id: 'm1',
        status: 'running',
        restartCount: 0,
      }]);

      const row = db.prepare('SELECT * FROM container_snapshots WHERE container_name = ?').get('minimal');
      assert.equal(row.cpu_percent, null);
      assert.equal(row.memory_mb, null);
      assert.equal(row.health_status, null);
      assert.equal(row.labels, null);
    });

    it('serializes object labels to JSON, accepts string labels as-is', () => {
      ingestContainers(db, 'h1', [
        { name: 'a', id: 'a', status: 'running', restartCount: 0, labels: { foo: 'bar' } },
        { name: 'b', id: 'b', status: 'running', restartCount: 0, labels: '{"already":"json"}' },
      ]);
      const a = db.prepare('SELECT labels FROM container_snapshots WHERE container_name = ?').get('a');
      const b = db.prepare('SELECT labels FROM container_snapshots WHERE container_name = ?').get('b');
      assert.equal(a.labels, '{"foo":"bar"}');
      assert.equal(b.labels, '{"already":"json"}');
    });

    it('inserts in a single transaction (atomic batch)', () => {
      ingestContainers(db, 'h1', [
        { name: 'a', id: 'a', status: 'running', restartCount: 0 },
        { name: 'b', id: 'b', status: 'running', restartCount: 0 },
        { name: 'c', id: 'c', status: 'exited', restartCount: 5 },
      ]);
      const count = db.prepare('SELECT COUNT(*) as c FROM container_snapshots').get().c;
      assert.equal(count, 3);
    });

    it('accepts an empty array without error', () => {
      ingestContainers(db, 'h1', []);
      const count = db.prepare('SELECT COUNT(*) as c FROM container_snapshots').get().c;
      assert.equal(count, 0);
    });
  });

  describe('ingestDisk', () => {
    it('inserts disk snapshots', () => {
      ingestDisk(db, 'h1', [
        { mountPoint: '/', totalGb: 100, usedGb: 60, usedPercent: 60 },
        { mountPoint: '/data', totalGb: 500, usedGb: 250, usedPercent: 50 },
      ]);
      const rows = db.prepare('SELECT * FROM disk_snapshots WHERE host_id = ? ORDER BY mount_point').all('h1');
      assert.equal(rows.length, 2);
      assert.equal(rows[0].mount_point, '/');
      assert.equal(rows[0].total_gb, 100);
      assert.equal(rows[0].used_percent, 60);
      assert.equal(rows[1].mount_point, '/data');
    });

    it('skips empty input', () => {
      ingestDisk(db, 'h1', []);
      assert.equal(db.prepare('SELECT COUNT(*) as c FROM disk_snapshots').get().c, 0);
    });
  });

  describe('ingestUpdates', () => {
    it('inserts update checks and converts hasUpdate boolean to int', () => {
      ingestUpdates(db, 'h1', [
        { containerName: 'nginx', image: 'nginx:1.25', localDigest: 'sha:a', remoteDigest: 'sha:b', hasUpdate: true },
        { containerName: 'redis', image: 'redis:7', localDigest: 'sha:c', remoteDigest: 'sha:c', hasUpdate: false },
      ]);
      const rows = db.prepare('SELECT * FROM update_checks WHERE host_id = ? ORDER BY container_name').all('h1');
      assert.equal(rows.length, 2);
      assert.equal(rows[0].container_name, 'nginx');
      assert.equal(rows[0].has_update, 1);
      assert.equal(rows[1].container_name, 'redis');
      assert.equal(rows[1].has_update, 0);
    });

    it('persists null digests', () => {
      ingestUpdates(db, 'h1', [
        { containerName: 'unknown', image: 'foo:latest', localDigest: null, remoteDigest: null, hasUpdate: false },
      ]);
      const row = db.prepare('SELECT * FROM update_checks').get();
      assert.equal(row.local_digest, null);
      assert.equal(row.remote_digest, null);
    });
  });

  describe('upsertHost', () => {
    it('inserts a new host with runtime defaulting to docker', () => {
      upsertHost(db, 'h1');
      const row = db.prepare('SELECT host_id, runtime_type, agent_version, host_group FROM hosts').get();
      assert.equal(row.host_id, 'h1');
      assert.equal(row.runtime_type, 'docker');
      assert.equal(row.agent_version, null);
      assert.equal(row.host_group, null);
    });

    it('records agent_version when supplied', () => {
      upsertHost(db, 'h1', '1.2.3');
      const row = db.prepare('SELECT agent_version FROM hosts').get();
      assert.equal(row.agent_version, '1.2.3');
    });

    it('records runtime_type when supplied', () => {
      upsertHost(db, 'h1', null, 'kubernetes');
      const row = db.prepare('SELECT runtime_type FROM hosts').get();
      assert.equal(row.runtime_type, 'kubernetes');
    });

    it('writes host_group from a non-empty string', () => {
      upsertHost(db, 'h1', null, 'docker', 'production');
      const row = db.prepare('SELECT host_group FROM hosts').get();
      assert.equal(row.host_group, 'production');
    });

    it('treats empty string and null hostGroup the same (NULL)', () => {
      upsertHost(db, 'h1', null, 'docker', '');
      assert.equal(db.prepare('SELECT host_group FROM hosts').get().host_group, null);
      upsertHost(db, 'h2', null, 'docker', null);
      assert.equal(db.prepare('SELECT host_group FROM hosts WHERE host_id = ?').get('h2').host_group, null);
    });

    it('updates last_seen, agent_version, runtime_type, host_group on conflict', () => {
      upsertHost(db, 'h1', '1.0.0', 'docker', 'staging');
      // Force a slightly different first_seen so we can verify it's preserved
      db.prepare("UPDATE hosts SET first_seen = '2026-01-01 00:00:00' WHERE host_id = ?").run('h1');

      upsertHost(db, 'h1', '2.0.0', 'kubernetes', 'production');

      const row = db.prepare('SELECT first_seen, agent_version, runtime_type, host_group FROM hosts WHERE host_id = ?').get('h1');
      assert.equal(row.first_seen, '2026-01-01 00:00:00', 'first_seen should be preserved');
      assert.equal(row.agent_version, '2.0.0');
      assert.equal(row.runtime_type, 'kubernetes');
      assert.equal(row.host_group, 'production');
    });

    it('does not touch host_group_override (UI override is preserved across agent collections)', () => {
      // Initial agent collection
      upsertHost(db, 'h1', '1.0.0', 'docker', 'agent-value');
      // User sets a manual override via the UI
      db.prepare('UPDATE hosts SET host_group_override = ? WHERE host_id = ?').run('user-value', 'h1');
      // Next agent collection arrives with a different group
      upsertHost(db, 'h1', '1.0.0', 'docker', 'changed-agent-value');

      const row = db.prepare('SELECT host_group, host_group_override FROM hosts WHERE host_id = ?').get('h1');
      assert.equal(row.host_group, 'changed-agent-value', 'agent value updated');
      assert.equal(row.host_group_override, 'user-value', 'manual override preserved');
    });
  });

  describe('ingestHost', () => {
    it('inserts a complete host snapshot', () => {
      ingestHost(db, 'h1', {
        cpuPercent: 42.5,
        memory: { totalMb: 16384, usedMb: 8192, availableMb: 8000, swapTotalMb: 2048, swapUsedMb: 100 },
        load: { load1: 1.5, load5: 1.2, load15: 0.9 },
        uptimeSeconds: 86400,
        gpuUtilizationPercent: 75,
        gpuMemoryUsedMb: 4096,
        gpuMemoryTotalMb: 8192,
        gpuTemperatureCelsius: 65,
        cpuTemperatureCelsius: 55,
        diskReadBytesPerSec: 1024,
        diskWriteBytesPerSec: 2048,
        netRxBytesPerSec: 4096,
        netTxBytesPerSec: 8192,
      });
      const row = db.prepare('SELECT * FROM host_snapshots WHERE host_id = ?').get('h1');
      assert.equal(row.cpu_percent, 42.5);
      assert.equal(row.memory_total_mb, 16384);
      assert.equal(row.memory_used_mb, 8192);
      assert.equal(row.swap_total_mb, 2048);
      assert.equal(row.load_1, 1.5);
      assert.equal(row.uptime_seconds, 86400);
      assert.equal(row.gpu_utilization_percent, 75);
      assert.equal(row.cpu_temperature_celsius, 55);
      assert.equal(row.disk_read_bytes_per_sec, 1024);
      assert.equal(row.net_tx_bytes_per_sec, 8192);
    });

    it('writes NULLs for missing optional fields', () => {
      ingestHost(db, 'h1', { cpuPercent: 10, memory: { totalMb: 1024, usedMb: 500 }, load: { load1: 0.5 }, uptimeSeconds: 100 });
      const row = db.prepare('SELECT * FROM host_snapshots WHERE host_id = ?').get('h1');
      assert.equal(row.cpu_percent, 10);
      assert.equal(row.memory_total_mb, 1024);
      assert.equal(row.memory_available_mb, null);
      assert.equal(row.gpu_utilization_percent, null);
      assert.equal(row.cpu_temperature_celsius, null);
    });

    it('is a no-op for null hostData', () => {
      ingestHost(db, 'h1', null);
      assert.equal(db.prepare('SELECT COUNT(*) as c FROM host_snapshots').get().c, 0);
    });
  });
});
