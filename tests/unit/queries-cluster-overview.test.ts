import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const { createTestDb } = require('../helpers/db');
const { getClusterOverview } = require('../../hub/src/web/queries');
const { upsertHost } = require('../../hub/src/ingest');

function ts(date: Date | number): string {
  const d = typeof date === 'number' ? new Date(date) : date;
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function seedK8sContainer(db: any, opts: {
  hostId: string;
  containerName: string;
  containerId: string;
  workloadKind?: string | null;
  health?: string | null;
}) {
  db.prepare("UPDATE hosts SET runtime_type='kubernetes' WHERE host_id = ?").run(opts.hostId);
  db.prepare(`
    INSERT INTO container_snapshots (host_id, container_name, container_id, status,
      cpu_percent, memory_mb, restart_count, network_rx_bytes, network_tx_bytes,
      blkio_read_bytes, blkio_write_bytes, health_status, health_check_output, labels,
      exit_code, size_rootfs_bytes, size_rw_bytes, cpu_limit_cores, cpu_limit_percent,
      memory_limit_mb, last_oom_killed_at, workload_kind, pod_ip, host_ip, pod_conditions, collected_at)
    VALUES (?, ?, ?, 'running', null, null, 0, null, null, null, null, ?, null, '{}', null,
            null, null, null, null, null, null, ?, null, null, null, ?)
  `).run(opts.hostId, opts.containerName, opts.containerId, opts.health ?? null,
         opts.workloadKind ?? null, ts(Date.now()));
  db.prepare(`
    INSERT INTO containers (host_id, container_name, first_seen, last_seen, removed_at)
    VALUES (?, ?, ?, ?, NULL)
    ON CONFLICT(host_id, container_name) DO UPDATE SET last_seen = excluded.last_seen, removed_at = NULL
  `).run(opts.hostId, opts.containerName, ts(Date.now()), ts(Date.now()));
}

describe('getClusterOverview', () => {
  let db: any;
  beforeEach(() => {
    db = createTestDb();
    upsertHost(db, 'k3d-server', 'v1', 'kubernetes', 'prod');
    upsertHost(db, 'k3d-worker', 'v1', 'kubernetes', 'prod');
  });
  afterEach(() => { db.close(); });

  it('returns empty namespaces and totals when nothing matches', () => {
    const out = getClusterOverview(db, 'prod', 15);
    assert.deepEqual(out.namespaces, []);
    assert.equal(out.totals.workloads, 0);
    assert.equal(out.totals.pods, 0);
    assert.equal(out.nodes.length, 2, 'still lists nodes that belong to the cluster');
  });

  it('groups across namespaces with correct counts', () => {
    seedK8sContainer(db, { hostId: 'k3d-server', containerName: 'default/web/nginx',
      containerId: 'uid-1/web/nginx', workloadKind: 'Deployment', health: 'healthy' });
    seedK8sContainer(db, { hostId: 'k3d-worker', containerName: 'default/web/nginx',
      containerId: 'uid-2/web/nginx', workloadKind: 'Deployment', health: 'unhealthy' });
    seedK8sContainer(db, { hostId: 'k3d-server', containerName: 'kube-system/coredns/coredns',
      containerId: 'uid-3/coredns/coredns', workloadKind: 'Deployment', health: 'healthy' });

    const out = getClusterOverview(db, 'prod', 15);
    assert.equal(out.namespaces.length, 2);
    const def = out.namespaces.find((n: any) => n.namespace === 'default')!;
    assert.equal(def.workload_count, 1);
    assert.equal(def.pod_count, 2);
    assert.equal(def.unhealthy_pod_count, 1);
    const ks = out.namespaces.find((n: any) => n.namespace === 'kube-system')!;
    assert.equal(ks.pod_count, 1);
    assert.equal(ks.unhealthy_pod_count, 0);

    assert.equal(out.totals.workloads, 2);
    assert.equal(out.totals.pods, 3);
    assert.equal(out.totals.healthy_pods, 2);
    assert.equal(out.totals.unhealthy_pods, 1);
  });

  it('counts multiple containers in the same pod (sidecars share podUid) as one pod', () => {
    seedK8sContainer(db, { hostId: 'k3d-server', containerName: 'default/web/nginx',
      containerId: 'uid-1/web/nginx', workloadKind: 'Deployment', health: 'healthy' });
    seedK8sContainer(db, { hostId: 'k3d-server', containerName: 'default/web/sidecar',
      containerId: 'uid-1/web/sidecar', workloadKind: 'Deployment', health: 'healthy' });
    const out = getClusterOverview(db, 'prod', 15);
    assert.equal(out.namespaces[0].pod_count, 1, 'sidecars share the podUid');
  });

  it('includes ingresses and PVCs in per-namespace counts and totals', () => {
    db.prepare(`INSERT INTO k8s_ingresses (cluster_id, namespace, name, ingress_class, hosts, paths, tls_hosts, external_ip, created_at, labels)
                VALUES ('prod', 'default', 'web-ing', null, '["app.local"]', '[]', null, null, null, null)`).run();
    db.prepare(`INSERT INTO pvc_snapshots (cluster_id, namespace, pvc_name, phase, capacity_bytes, storage_class, collected_at)
                VALUES ('prod', 'default', 'data', 'Pending', null, 'local', datetime('now'))`).run();
    db.prepare(`INSERT INTO pvc_snapshots (cluster_id, namespace, pvc_name, phase, capacity_bytes, storage_class, collected_at)
                VALUES ('prod', 'default', 'logs', 'Bound', 5e9, 'local', datetime('now'))`).run();
    const out = getClusterOverview(db, 'prod', 15);
    const def = out.namespaces.find((n: any) => n.namespace === 'default')!;
    assert.equal(def.ingress_count, 1);
    assert.equal(def.pvc_count, 2);
    assert.equal(def.pvc_pending_count, 1);
    assert.equal(out.totals.ingresses, 1);
    assert.equal(out.totals.pvcs, 2);
    assert.equal(out.totals.pvcs_pending, 1);
  });

  it('counts active alerts per namespace by parsing target prefix', () => {
    seedK8sContainer(db, { hostId: 'k3d-server', containerName: 'default/web/nginx',
      containerId: 'uid-1/web/nginx', workloadKind: 'Deployment', health: 'healthy' });
    db.prepare(`
      INSERT INTO alert_state (host_id, alert_type, target, triggered_at, last_notified, notify_count)
      VALUES ('k3d-server', 'restart_loop', 'default/web/nginx', datetime('now'), datetime('now'), 1)
    `).run();
    db.prepare(`
      INSERT INTO alert_state (host_id, alert_type, target, triggered_at, last_notified, notify_count, resolved_at)
      VALUES ('k3d-server', 'restart_loop', 'default/web/nginx', datetime('now', '-1 hour'), datetime('now', '-1 hour'), 1, datetime('now', '-30 minutes'))
    `).run();
    const out = getClusterOverview(db, 'prod', 15);
    assert.equal(out.namespaces[0].active_alert_count, 1, 'resolved alert excluded');
    assert.equal(out.totals.active_alerts, 1);
  });

  it('lists all cluster nodes online status with pod counts', () => {
    seedK8sContainer(db, { hostId: 'k3d-server', containerName: 'default/web/nginx',
      containerId: 'uid-1/web/nginx', workloadKind: 'Deployment', health: 'healthy' });
    const out = getClusterOverview(db, 'prod', 15);
    assert.equal(out.nodes.length, 2);
    const server = out.nodes.find((n: any) => n.host_id === 'k3d-server')!;
    assert.equal(server.pod_count, 1);
    const worker = out.nodes.find((n: any) => n.host_id === 'k3d-worker')!;
    assert.equal(worker.pod_count, 0);
  });
});
