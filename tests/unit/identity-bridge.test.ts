import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const { createTestDb } = require('../helpers/db');
const { suppressConsole } = require('../helpers/mocks');

const { upsertHost } = require('../../hub/src/ingest');
const queries = require('../../hub/src/web/queries');

describe('Proxmox identity bridge (PR4)', () => {
  let db: any;
  let restore: () => void;

  beforeEach(() => {
    restore = suppressConsole();
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
    restore();
  });

  function seedPveHost(hostId = 'pve-01'): void {
    db.prepare(
      `INSERT INTO hosts (host_id, first_seen, last_seen, runtime_type)
       VALUES (?, datetime('now'), datetime('now'), 'proxmox')`
    ).run(hostId);
  }

  function seedPveContainer(opts: { hostId?: string; node?: string; vmid: number; name?: string }): void {
    const host = opts.hostId ?? 'pve-01';
    const node = opts.node ?? 'pve-01';
    const name = opts.name ?? `${node}/${opts.vmid}`;
    db.prepare(`
      INSERT INTO container_snapshots
        (host_id, container_name, container_id, status, restart_count,
         guest_type, guest_vmid, collected_at)
      VALUES (?, ?, ?, 'running', 0, 'qemu', ?, datetime('now'))
    `).run(host, name, `qemu/${opts.vmid}`, opts.vmid);
  }

  // ── upsertHost round-trip ─────────────────────────────────────────────────

  it('upsertHost stores and updates host_labels JSON', () => {
    upsertHost(db, 'web-1', '0.3.0', 'docker', null, { 'insightd.proxmox.guest': 'pve-01/103' });
    let row = db.prepare(`SELECT host_labels FROM hosts WHERE host_id = 'web-1'`).get() as any;
    assert.equal(row.host_labels, JSON.stringify({ 'insightd.proxmox.guest': 'pve-01/103' }));

    // Subsequent upsert with empty labels clears them — operators may unset
    // the env vars without losing visibility.
    upsertHost(db, 'web-1', '0.3.0', 'docker', null, {});
    row = db.prepare(`SELECT host_labels FROM hosts WHERE host_id = 'web-1'`).get() as any;
    assert.equal(row.host_labels, null);
  });

  it('upsertHost without hostLabels arg leaves the column NULL (back-compat)', () => {
    upsertHost(db, 'docker-01', '0.3.0', 'docker', null);
    const row = db.prepare(`SELECT host_labels FROM hosts WHERE host_id = 'docker-01'`).get() as any;
    assert.equal(row.host_labels, null);
  });

  // ── PVE container detail → in-guest host link ──────────────────────────────

  it('getPveGuestExtras populates linkedInGuestHostId when the bridge label points back', () => {
    seedPveHost('pve-01');
    seedPveContainer({ hostId: 'pve-01', node: 'pve-01', vmid: 103, name: 'pve-01/103' });
    upsertHost(db, 'web-1', '0.3.0', 'docker', null, { 'insightd.proxmox.guest': 'pve-01/103' });

    const extras = queries.getPveGuestExtras(db, 'pve-01', 'pve-01/103');
    assert.ok(extras);
    assert.equal(extras.linkedInGuestHostId, 'web-1');
  });

  it('linkedInGuestHostId is null when no in-guest agent has the matching label', () => {
    seedPveHost('pve-01');
    seedPveContainer({ vmid: 103 });
    // No upsertHost for an in-guest agent at all.
    const extras = queries.getPveGuestExtras(db, 'pve-01', 'pve-01/103');
    assert.ok(extras);
    assert.equal(extras.linkedInGuestHostId, null);
  });

  it('linkedInGuestHostId is null when an unrelated host has a different proxmox label', () => {
    seedPveHost('pve-01');
    seedPveContainer({ vmid: 103 });
    upsertHost(db, 'web-2', '0.3.0', 'docker', null, { 'insightd.proxmox.guest': 'pve-01/200' });
    const extras = queries.getPveGuestExtras(db, 'pve-01', 'pve-01/103');
    assert.equal(extras.linkedInGuestHostId, null);
  });

  // ── In-guest host detail → PVE hypervisor link ────────────────────────────

  it('getHostDetail returns pveHypervisor when an in-guest agent advertises the bridge label', () => {
    seedPveHost('pve-01');
    seedPveContainer({ hostId: 'pve-01', node: 'pve-01', vmid: 103, name: 'pve-01/103' });
    upsertHost(db, 'web-1', '0.3.0', 'docker', null, { 'insightd.proxmox.guest': 'pve-01/103' });

    const detail = queries.getHostDetail(db, 'web-1', 60);
    assert.ok(detail.pveHypervisor);
    assert.equal(detail.pveHypervisor.pveHostId, 'pve-01');
    assert.equal(detail.pveHypervisor.containerName, 'pve-01/103');
  });

  it('getHostDetail.pveHypervisor is null on hosts without the bridge label', () => {
    upsertHost(db, 'docker-01', '0.3.0', 'docker', null, null);
    const detail = queries.getHostDetail(db, 'docker-01', 60);
    assert.equal(detail.pveHypervisor, null);
  });

  it('getHostDetail.pveHypervisor is null on PVE hosts themselves (they ARE the hypervisor)', () => {
    seedPveHost('pve-01');
    const detail = queries.getHostDetail(db, 'pve-01', 60);
    assert.equal(detail.pveHypervisor, null);
  });
});
