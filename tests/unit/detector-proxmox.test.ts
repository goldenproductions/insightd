import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const { createTestDb } = require('../helpers/db');
const { suppressConsole } = require('../helpers/mocks');
const { generateInsights } = require('../../hub/src/insights/detector');

interface Insight {
  entity_type: string;
  entity_id: string;
  category: string;
  severity: string;
  title: string;
  message: string;
}

describe('detector — Proxmox VE checks (PR3)', () => {
  let db: any;
  let restore: () => void;

  beforeEach(() => {
    restore = suppressConsole();
    db = createTestDb();
    // Seed a PVE host so generateInsights' upstream queries find at least
    // one host (the PVE checks themselves don't need this, but the existing
    // detector loops do).
    db.prepare(
      `INSERT INTO hosts (host_id, first_seen, last_seen, runtime_type)
       VALUES ('pve-01', datetime('now'), datetime('now'), 'proxmox')`
    ).run();
  });

  afterEach(() => {
    db.close();
    restore();
  });

  function getInsightsByCategory(category: string): Insight[] {
    return db.prepare(
      `SELECT entity_type, entity_id, category, severity, title, message
       FROM insights WHERE category = ? ORDER BY entity_id, title`
    ).all(category) as Insight[];
  }

  function upsertCluster(opts: { quorate: number; total?: number; online?: number; name?: string }) {
    db.prepare(`
      INSERT INTO pve_cluster_status (cluster_name, quorate, total_nodes, online_nodes)
      VALUES (?, ?, ?, ?)
    `).run(opts.name ?? 'home', opts.quorate, opts.total ?? 3, opts.online ?? 3);
  }

  function upsertZfs(opts: { name: string; health: string; hostId?: string }) {
    db.prepare(`
      INSERT INTO pve_zfs_pools (host_id, pool_name, health, observed_at)
      VALUES (?, ?, ?, datetime('now'))
    `).run(opts.hostId ?? 'pve-01', opts.name, opts.health);
  }

  function insertGuest(opts: { vmid: number; name: string; type?: 'qemu' | 'lxc'; hostId?: string }) {
    db.prepare(`
      INSERT INTO container_snapshots
        (host_id, container_name, container_id, status, restart_count,
         guest_type, guest_vmid, collected_at)
      VALUES (?, ?, ?, 'running', 0, ?, ?, datetime('now'))
    `).run(opts.hostId ?? 'pve-01', opts.name, `${opts.type ?? 'qemu'}/${opts.vmid}`,
      opts.type ?? 'qemu', opts.vmid);
  }

  function upsertBackup(opts: { vmid: number; status: 'OK' | 'FAILED' | 'NEVER'; hostId?: string }) {
    db.prepare(`
      INSERT INTO pve_guest_backups (host_id, guest_vmid, last_backup_at, last_status)
      VALUES (?, ?, NULL, ?)
    `).run(opts.hostId ?? 'pve-01', opts.vmid, opts.status);
  }

  function upsertSnapshotSummary(opts: { vmid: number; count: number; oldestDaysAgo?: number; hostId?: string }) {
    const oldestExpr = opts.oldestDaysAgo != null ? `datetime('now', '-${opts.oldestDaysAgo} days')` : 'NULL';
    db.prepare(`
      INSERT INTO pve_guest_snapshots (host_id, guest_vmid, snapshot_count, oldest_at, newest_at)
      VALUES (?, ?, ?, ${oldestExpr}, datetime('now'))
    `).run(opts.hostId ?? 'pve-01', opts.vmid, opts.count);
  }

  // ── host-scope: cluster quorum lost ────────────────────────────────────────

  it('emits a critical proxmox insight when cluster is non-quorate', () => {
    upsertCluster({ quorate: 0, total: 3, online: 1, name: 'home' });
    generateInsights(db);
    const items = getInsightsByCategory('proxmox');
    const quorum = items.find(i => i.title.includes('lost quorum'));
    assert.ok(quorum, 'expected a quorum-lost insight');
    assert.equal(quorum!.severity, 'critical');
    assert.equal(quorum!.entity_type, 'host');
    assert.equal(quorum!.entity_id, 'home');
    assert.match(quorum!.message, /pvecm status/);
  });

  it('emits no quorum insight when cluster is quorate', () => {
    upsertCluster({ quorate: 1 });
    generateInsights(db);
    const items = getInsightsByCategory('proxmox');
    assert.equal(items.filter(i => i.title.includes('quorum')).length, 0);
  });

  // ── host-scope: ZFS health ─────────────────────────────────────────────────

  it('emits warning for DEGRADED ZFS pool with zpool-status suggested action', () => {
    upsertZfs({ name: 'rpool', health: 'DEGRADED' });
    generateInsights(db);
    const items = getInsightsByCategory('proxmox');
    const zfs = items.find(i => i.title.includes('rpool'));
    assert.ok(zfs);
    assert.equal(zfs!.severity, 'warning');
    assert.match(zfs!.message, /zpool status -v rpool/);
  });

  it('escalates FAULTED/UNAVAIL ZFS pools to critical', () => {
    upsertZfs({ name: 'tank', health: 'FAULTED' });
    generateInsights(db);
    const items = getInsightsByCategory('proxmox');
    const zfs = items.find(i => i.title.includes('tank'));
    assert.equal(zfs!.severity, 'critical');
  });

  // ── guest-scope: backups ───────────────────────────────────────────────────

  // Per-guest backup insights only fire in the *mixed* case — host has some
  // backed-up guests + a few forgotten ones. When the entire host has no
  // backups, the host-scope "no automated backups configured" insight covers
  // it (see "host-scope: no backups configured" suite below).
  function upsertBackupWithDate(opts: { vmid: number; status: 'OK' | 'FAILED'; daysAgo: number; hostId?: string }) {
    db.prepare(`
      INSERT INTO pve_guest_backups (host_id, guest_vmid, last_backup_at, last_status)
      VALUES (?, ?, datetime('now', '-${opts.daysAgo} days'), ?)
    `).run(opts.hostId ?? 'pve-01', opts.vmid, opts.status);
  }

  it('emits a warning insight when a QEMU guest has never been backed up (mixed host)', () => {
    insertGuest({ vmid: 103, name: 'pve-01/103', type: 'qemu' });
    insertGuest({ vmid: 104, name: 'pve-01/104', type: 'qemu' });
    upsertBackup({ vmid: 103, status: 'NEVER' });
    upsertBackupWithDate({ vmid: 104, status: 'OK', daysAgo: 1 });
    generateInsights(db);
    const items = getInsightsByCategory('proxmox');
    const backup = items.find(i => i.title.includes('never been backed up'));
    assert.ok(backup);
    assert.equal(backup!.severity, 'warning');
    assert.match(backup!.message, /VM disk image/);
  });

  it('emits info-level insight (not warning) for an LXC guest that has never been backed up (mixed host)', () => {
    insertGuest({ vmid: 200, name: 'pve-01/200', type: 'lxc' });
    insertGuest({ vmid: 201, name: 'pve-01/201', type: 'qemu' });
    upsertBackup({ vmid: 200, status: 'NEVER' });
    upsertBackupWithDate({ vmid: 201, status: 'OK', daysAgo: 1 });
    generateInsights(db);
    const items = getInsightsByCategory('proxmox');
    const backup = items.find(i => i.title.includes('never been backed up'));
    assert.ok(backup);
    assert.equal(backup!.severity, 'info');
    assert.match(backup!.message, /LXC containers are cheap to rebuild/);
  });

  // ── host-scope: no backups configured ──────────────────────────────────────

  it('emits one host-scope insight (not N per-guest insights) when ALL guests are NEVER', () => {
    insertGuest({ vmid: 100, name: 'pve-01/100', type: 'qemu' });
    insertGuest({ vmid: 101, name: 'pve-01/101', type: 'lxc' });
    insertGuest({ vmid: 102, name: 'pve-01/102', type: 'qemu' });
    upsertBackup({ vmid: 100, status: 'NEVER' });
    upsertBackup({ vmid: 101, status: 'NEVER' });
    upsertBackup({ vmid: 102, status: 'NEVER' });
    generateInsights(db);
    const items = getInsightsByCategory('proxmox');
    const hostScope = items.filter(i => i.title.includes('no automated backups configured'));
    assert.equal(hostScope.length, 1);
    assert.equal(hostScope[0].entity_type, 'host');
    assert.equal(hostScope[0].entity_id, 'pve-01');
    assert.equal(hostScope[0].severity, 'warning');
    assert.match(hostScope[0].message, /3 guests/);
    assert.match(hostScope[0].message, /Datacenter → Backup/);
    assert.equal(items.filter(i => i.title.includes('never been backed up')).length, 0);
  });

  // ── guest-scope: snapshot accumulation ─────────────────────────────────────

  it('emits info insight when a guest has > 8 snapshots', () => {
    insertGuest({ vmid: 103, name: 'pve-01/103', type: 'qemu' });
    upsertSnapshotSummary({ vmid: 103, count: 12, oldestDaysAgo: 90 });
    generateInsights(db);
    const items = getInsightsByCategory('proxmox');
    const snap = items.find(i => i.title.includes('12 snapshots'));
    assert.ok(snap);
    assert.equal(snap!.severity, 'info');
    assert.match(snap!.message, /copy-on-write/);
  });

  it('does not emit a snapshot insight at the threshold (8 is fine)', () => {
    insertGuest({ vmid: 103, name: 'pve-01/103', type: 'qemu' });
    upsertSnapshotSummary({ vmid: 103, count: 8 });
    generateInsights(db);
    const items = getInsightsByCategory('proxmox');
    assert.equal(items.filter(i => i.title.includes('snapshots')).length, 0);
  });

  // ── all-clear ─────────────────────────────────────────────────────────────

  it('emits no proxmox insights when everything is healthy', () => {
    upsertCluster({ quorate: 1 });
    upsertZfs({ name: 'rpool', health: 'ONLINE' });
    insertGuest({ vmid: 103, name: 'pve-01/103', type: 'qemu' });
    db.prepare(`
      INSERT INTO pve_guest_backups (host_id, guest_vmid, last_backup_at, last_status)
      VALUES ('pve-01', 103, datetime('now', '-1 days'), 'OK')
    `).run();
    upsertSnapshotSummary({ vmid: 103, count: 2 });
    generateInsights(db);
    assert.equal(getInsightsByCategory('proxmox').length, 0);
  });
});
