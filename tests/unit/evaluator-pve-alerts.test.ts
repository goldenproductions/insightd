import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
const { createTestDb } = require('../helpers/db');
const { suppressConsole } = require('../helpers/mocks');
const nodemailer = require('nodemailer');

describe('evaluateAlerts — Proxmox VE (PR2)', () => {
  let db: any;
  let evaluateAlerts: Function;
  let restore: () => void;

  beforeEach(() => {
    restore = suppressConsole();
    mock.method(nodemailer, 'createTransport', () => ({ sendMail: mock.fn(async () => ({ messageId: 't' })) }));
    db = createTestDb();
    delete require.cache[require.resolve('../../hub/src/alerts/evaluator')];
    delete require.cache[require.resolve('../../hub/src/alerts/sender')];
    evaluateAlerts = require('../../hub/src/alerts/evaluator').evaluateAlerts;
  });

  afterEach(() => {
    db.close();
    restore();
    mock.restoreAll();
  });

  // Minimal config — disable everything except the disk threshold (which is
  // shared between disk_full and pve_storage_saturation). PVE alerts have no
  // toggle: they fire whenever PVE data is present in the tables.
  const cfg = {
    enabled: true, to: 't@t.com', cooldownMinutes: 60,
    containerDown: false, restartCount: 0,
    cpuPercent: 0, memoryMb: 0, diskPercent: 85,
    hostCpuPercent: 0, hostMemoryAvailableMb: 0, hostLoadThreshold: 0,
    hostOffline: false, hostOfflineMinutes: 0,
    containerUnhealthy: false, excludeContainers: '',
    endpointDown: false, endpointFailureThreshold: 3,
    podPending: false,
    workloadUnavailable: false, workloadDegraded: false, workloadRolloutStuck: false,
  };

  function upsertZfsPool(opts: { hostId?: string; name: string; health: string; sizeBytes?: number; allocBytes?: number }) {
    db.prepare(`
      INSERT INTO pve_zfs_pools (host_id, pool_name, health, size_bytes, alloc_bytes, observed_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(host_id, pool_name) DO UPDATE SET
        health=excluded.health, observed_at=excluded.observed_at
    `).run(opts.hostId ?? 'pve-01', opts.name, opts.health,
      opts.sizeBytes ?? null, opts.allocBytes ?? null);
  }

  function upsertCluster(opts: { name?: string; quorate: number; total?: number; online?: number }) {
    db.prepare(`
      INSERT INTO pve_cluster_status (cluster_name, quorate, total_nodes, online_nodes, observed_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(cluster_name) DO UPDATE SET
        quorate=excluded.quorate, observed_at=excluded.observed_at
    `).run(opts.name ?? 'home', opts.quorate, opts.total ?? 3, opts.online ?? 3);
  }

  function insertStorageSnapshot(opts: {
    hostId?: string; name: string; type?: string;
    totalBytes: number; usedBytes: number; active?: number;
  }) {
    db.prepare(`
      INSERT INTO pve_storage_snapshots
        (host_id, storage_name, storage_type, total_bytes, used_bytes, active, shared, collected_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, datetime('now'))
    `).run(opts.hostId ?? 'pve-01', opts.name, opts.type ?? 'dir',
      opts.totalBytes, opts.usedBytes, opts.active ?? 1);
  }

  // ── pve_zfs_unhealthy ─────────────────────────────────────────────────────

  it('fires pve_zfs_unhealthy for any non-ONLINE pool', () => {
    upsertZfsPool({ name: 'rpool', health: 'DEGRADED', sizeBytes: 1e12, allocBytes: 5e11 });
    upsertZfsPool({ name: 'tank', health: 'ONLINE', sizeBytes: 1e12, allocBytes: 1e11 });
    const { triggered } = evaluateAlerts(db, { alerts: cfg });
    const fired = triggered.filter((a: any) => a.type === 'pve_zfs_unhealthy');
    assert.equal(fired.length, 1);
    assert.equal(fired[0].target, 'rpool');
    assert.equal(fired[0].hostId, 'pve-01');
    assert.match(fired[0].message, /DEGRADED/);
    assert.match(fired[0].message, /zpool status rpool/);
  });

  it('fires once per unhealthy pool (FAULTED + DEGRADED both surface)', () => {
    upsertZfsPool({ name: 'rpool', health: 'DEGRADED' });
    upsertZfsPool({ name: 'backup', health: 'FAULTED' });
    const { triggered } = evaluateAlerts(db, { alerts: cfg });
    const fired = triggered.filter((a: any) => a.type === 'pve_zfs_unhealthy');
    assert.equal(fired.length, 2);
    assert.deepEqual(fired.map((f: any) => f.target).sort(), ['backup', 'rpool']);
  });

  it('does not fire pve_zfs_unhealthy when all pools are ONLINE', () => {
    upsertZfsPool({ name: 'rpool', health: 'ONLINE' });
    const { triggered } = evaluateAlerts(db, { alerts: cfg });
    assert.equal(triggered.filter((a: any) => a.type === 'pve_zfs_unhealthy').length, 0);
  });

  // ── pve_cluster_quorum_lost ────────────────────────────────────────────────

  it('fires pve_cluster_quorum_lost when quorate=0', () => {
    upsertCluster({ name: 'home', quorate: 0, total: 3, online: 1 });
    const { triggered } = evaluateAlerts(db, { alerts: cfg });
    const fired = triggered.filter((a: any) => a.type === 'pve_cluster_quorum_lost');
    assert.equal(fired.length, 1);
    // hostId is the cluster name (cluster-scoped, not a real host) so the
    // alert dedups across every PVE node that publishes the same status.
    assert.equal(fired[0].hostId, 'home');
    assert.equal(fired[0].target, 'quorum');
    assert.match(fired[0].message, /lost quorum/);
    assert.match(fired[0].message, /1\/3/);
  });

  it('does not fire pve_cluster_quorum_lost when quorate', () => {
    upsertCluster({ quorate: 1 });
    const { triggered } = evaluateAlerts(db, { alerts: cfg });
    assert.equal(triggered.filter((a: any) => a.type === 'pve_cluster_quorum_lost').length, 0);
  });

  // ── pve_storage_saturation ─────────────────────────────────────────────────

  it('fires pve_storage_saturation above the disk threshold', () => {
    insertStorageSnapshot({ name: 'local-zfs', totalBytes: 1000, usedBytes: 900 }); // 90%
    const { triggered } = evaluateAlerts(db, { alerts: cfg });
    const fired = triggered.filter((a: any) => a.type === 'pve_storage_saturation');
    assert.equal(fired.length, 1);
    assert.equal(fired[0].target, 'local-zfs');
    assert.equal(fired[0].value, 90);
    assert.equal(fired[0].threshold, 85);
  });

  it('does not fire pve_storage_saturation below threshold', () => {
    insertStorageSnapshot({ name: 'local-zfs', totalBytes: 1000, usedBytes: 800 });
    const { triggered } = evaluateAlerts(db, { alerts: cfg });
    assert.equal(triggered.filter((a: any) => a.type === 'pve_storage_saturation').length, 0);
  });

  it('skips inactive storages so we do not alert on 0/0', () => {
    insertStorageSnapshot({ name: 'detached-nfs', totalBytes: 0, usedBytes: 0, active: 0 });
    const { triggered } = evaluateAlerts(db, { alerts: cfg });
    assert.equal(triggered.filter((a: any) => a.type === 'pve_storage_saturation').length, 0);
  });

  it('only considers the latest snapshot per storage', () => {
    // First cycle: above threshold. Second cycle (now): below. Should not fire.
    db.prepare(`
      INSERT INTO pve_storage_snapshots
        (host_id, storage_name, storage_type, total_bytes, used_bytes, active, shared, collected_at)
      VALUES ('pve-01', 'local', 'dir', 1000, 950, 1, 0, datetime('now', '-10 minutes'))
    `).run();
    insertStorageSnapshot({ name: 'local', totalBytes: 1000, usedBytes: 100 });
    const { triggered } = evaluateAlerts(db, { alerts: cfg });
    assert.equal(triggered.filter((a: any) => a.type === 'pve_storage_saturation').length, 0);
  });

  // ── pve_backup_overdue (PR3) ───────────────────────────────────────────────

  function upsertBackup(opts: { hostId?: string; vmid: number; daysAgo?: number | null; status: 'OK' | 'FAILED' | 'NEVER' }) {
    const at = opts.daysAgo == null ? null : `datetime('now', '-${opts.daysAgo} days')`;
    db.prepare(`
      INSERT INTO pve_guest_backups (host_id, guest_vmid, last_backup_at, last_status, observed_at)
      VALUES (?, ?, ${at ?? 'NULL'}, ?, datetime('now'))
      ON CONFLICT(host_id, guest_vmid) DO UPDATE SET
        last_backup_at = excluded.last_backup_at, last_status = excluded.last_status
    `).run(opts.hostId ?? 'pve-01', opts.vmid, opts.status);
  }

  function insertGuestSnapshot(opts: { hostId?: string; vmid: number; name?: string }) {
    db.prepare(`
      INSERT INTO container_snapshots
        (host_id, container_name, container_id, status, restart_count,
         guest_type, guest_vmid, collected_at)
      VALUES (?, ?, ?, 'running', 0, 'qemu', ?, datetime('now'))
    `).run(opts.hostId ?? 'pve-01', opts.name ?? `pve-01/${opts.vmid}`,
      `qemu/${opts.vmid}`, opts.vmid);
  }

  it('fires pve_backup_overdue when last successful vzdump is older than the warn window', () => {
    insertGuestSnapshot({ vmid: 103, name: 'pve-01/103' });
    upsertBackup({ vmid: 103, daysAgo: 14, status: 'OK' });
    const { triggered } = evaluateAlerts(db, { alerts: { ...cfg, pveBackupAgeWarnDays: 7 } });
    const fired = triggered.filter((a: any) => a.type === 'pve_backup_overdue');
    assert.equal(fired.length, 1);
    assert.equal(fired[0].target, '103');
    assert.match(fired[0].message, /pve-01\/103/);
    assert.match(fired[0].message, /14d ago/);
  });

  it('fires pve_backup_overdue with NEVER message for guests that have never been backed up', () => {
    insertGuestSnapshot({ vmid: 200, name: 'pve-01/200' });
    upsertBackup({ vmid: 200, daysAgo: null, status: 'NEVER' });
    const { triggered } = evaluateAlerts(db, { alerts: { ...cfg, pveBackupAgeWarnDays: 7 } });
    const fired = triggered.filter((a: any) => a.type === 'pve_backup_overdue');
    assert.equal(fired.length, 1);
    assert.match(fired[0].message, /never backed up/);
  });

  it('does not fire pve_backup_overdue when backup is within the warn window', () => {
    insertGuestSnapshot({ vmid: 103, name: 'pve-01/103' });
    upsertBackup({ vmid: 103, daysAgo: 3, status: 'OK' });
    const { triggered } = evaluateAlerts(db, { alerts: { ...cfg, pveBackupAgeWarnDays: 7 } });
    assert.equal(triggered.filter((a: any) => a.type === 'pve_backup_overdue').length, 0);
  });

  it('disables pve_backup_overdue when pveBackupAgeWarnDays is 0', () => {
    insertGuestSnapshot({ vmid: 103 });
    upsertBackup({ vmid: 103, daysAgo: null, status: 'NEVER' });
    const { triggered } = evaluateAlerts(db, { alerts: { ...cfg, pveBackupAgeWarnDays: 0 } });
    assert.equal(triggered.filter((a: any) => a.type === 'pve_backup_overdue').length, 0);
  });
});
