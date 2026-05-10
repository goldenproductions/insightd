import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerResponse, IncomingMessage } from 'node:http';
const { createTestDb } = require('../helpers/db');
const { handleAgentSetupCheck } = require('../../hub/src/web/handlers');

function fakeReq(url: string): IncomingMessage {
  return { url, headers: { host: 'localhost' } } as unknown as IncomingMessage;
}
const fakeRes = {} as ServerResponse;
const cfg = {};

interface Result {
  status: 'waiting' | 'connected';
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  proxmoxLink: { node: string; vmid: number; guestType: 'qemu' | 'lxc' } | null;
  pveCluster: string | null;
}

describe('handleAgentSetupCheck', () => {
  let db: any;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('returns waiting when no host row exists (target=docker)', () => {
    const r = handleAgentSetupCheck(fakeReq('/api/agent-setup/check?identifier=nas-01&target=docker'), fakeRes, db, cfg) as Result;
    assert.equal(r.status, 'waiting');
    assert.equal(r.firstSeenAt, null);
    assert.equal(r.proxmoxLink, null);
    assert.equal(r.pveCluster, null);
  });

  it('returns connected when host row exists (target=docker)', () => {
    db.prepare(`INSERT INTO hosts (host_id, first_seen, last_seen, runtime_type) VALUES ('nas-01', '2026-05-10T00:00:00Z', '2026-05-10T00:00:30Z', 'docker')`).run();
    const r = handleAgentSetupCheck(fakeReq('/api/agent-setup/check?identifier=nas-01&target=docker'), fakeRes, db, cfg) as Result;
    assert.equal(r.status, 'connected');
    assert.equal(r.firstSeenAt, '2026-05-10T00:00:00Z');
    assert.equal(r.lastSeenAt, '2026-05-10T00:00:30Z');
  });

  it('populates proxmoxLink for in-guest target when host has proxmox_* set', () => {
    db.prepare(`INSERT INTO hosts (host_id, first_seen, last_seen, runtime_type, proxmox_node, proxmox_vmid, proxmox_guest_type, proxmox_cluster_id)
                VALUES ('n8n-vm', 't1', 't2', 'docker', 'proxmox-01', 108, 'qemu', 'homelab')`).run();
    const r = handleAgentSetupCheck(fakeReq('/api/agent-setup/check?identifier=n8n-vm&target=in-guest'), fakeRes, db, cfg) as Result;
    assert.equal(r.status, 'connected');
    assert.deepEqual(r.proxmoxLink, { node: 'proxmox-01', vmid: 108, guestType: 'qemu' });
  });

  it('returns proxmoxLink=null for in-guest target when host has no PVE link yet', () => {
    db.prepare(`INSERT INTO hosts (host_id, first_seen, last_seen, runtime_type) VALUES ('n8n-vm', 't1', 't2', 'docker')`).run();
    const r = handleAgentSetupCheck(fakeReq('/api/agent-setup/check?identifier=n8n-vm&target=in-guest'), fakeRes, db, cfg) as Result;
    assert.equal(r.status, 'connected');
    assert.equal(r.proxmoxLink, null);
  });

  it('populates pveCluster for pve target when proxmox_cluster_id matches a pve_cluster_status row', () => {
    db.prepare(`INSERT INTO hosts (host_id, first_seen, last_seen, runtime_type, proxmox_cluster_id) VALUES ('proxmox-01', 't1', 't2', 'docker', 'homelab')`).run();
    db.prepare(`INSERT INTO pve_cluster_status (cluster_name, quorate, total_nodes, online_nodes) VALUES ('homelab', 1, 3, 3)`).run();
    const r = handleAgentSetupCheck(fakeReq('/api/agent-setup/check?identifier=proxmox-01&target=pve'), fakeRes, db, cfg) as Result;
    assert.equal(r.status, 'connected');
    assert.equal(r.pveCluster, 'homelab');
  });

  it('returns pveCluster=null for pve target on standalone PVE (no pve_cluster_status row)', () => {
    db.prepare(`INSERT INTO hosts (host_id, first_seen, last_seen, runtime_type) VALUES ('standalone-pve', 't1', 't2', 'docker')`).run();
    const r = handleAgentSetupCheck(fakeReq('/api/agent-setup/check?identifier=standalone-pve&target=pve'), fakeRes, db, cfg) as Result;
    assert.equal(r.status, 'connected');
    assert.equal(r.pveCluster, null);
  });

  it('returns connected when at least one k8s host has matching host_group (target=k8s)', () => {
    db.prepare(`INSERT INTO hosts (host_id, first_seen, last_seen, runtime_type, host_group) VALUES ('node-1', 't1', 't2', 'kubernetes', 'homelab-k3s')`).run();
    const r = handleAgentSetupCheck(fakeReq('/api/agent-setup/check?identifier=homelab-k3s&target=k8s'), fakeRes, db, cfg) as Result;
    assert.equal(r.status, 'connected');
  });

  it('returns waiting for k8s when only non-k8s hosts share the host_group label', () => {
    db.prepare(`INSERT INTO hosts (host_id, first_seen, last_seen, runtime_type, host_group) VALUES ('docker-host', 't1', 't2', 'docker', 'homelab')`).run();
    const r = handleAgentSetupCheck(fakeReq('/api/agent-setup/check?identifier=homelab&target=k8s'), fakeRes, db, cfg) as Result;
    assert.equal(r.status, 'waiting');
  });

  it('returns waiting for empty identifier', () => {
    const r = handleAgentSetupCheck(fakeReq('/api/agent-setup/check?identifier=&target=docker'), fakeRes, db, cfg) as Result;
    assert.equal(r.status, 'waiting');
  });

  it('returns waiting for invalid target value', () => {
    db.prepare(`INSERT INTO hosts (host_id, first_seen, last_seen, runtime_type) VALUES ('nas-01', 't1', 't2', 'docker')`).run();
    const r = handleAgentSetupCheck(fakeReq('/api/agent-setup/check?identifier=nas-01&target=bad'), fakeRes, db, cfg) as Result;
    assert.equal(r.status, 'waiting');
  });
});
