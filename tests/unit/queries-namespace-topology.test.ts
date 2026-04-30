import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const { createTestDb } = require('../helpers/db');
const { getNamespaceTopology } = require('../../hub/src/web/queries');
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
  // Mark the host as kubernetes so the topology query's runtime_type filter passes.
  db.prepare("UPDATE hosts SET runtime_type='kubernetes' WHERE host_id = ?").run(opts.hostId);
  // Seed the snapshot with the new v42 columns.
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

describe('getNamespaceTopology', () => {
  let db: any;
  beforeEach(() => {
    db = createTestDb();
    upsertHost(db, 'k3d-server', 'v1', 'kubernetes', 'prod');
    upsertHost(db, 'k3d-worker', 'v1', 'kubernetes', 'prod');
  });
  afterEach(() => { db.close(); });

  it('returns empty topology when nothing matches', () => {
    const out = getNamespaceTopology(db, 'prod', 'kube-system', 15);
    assert.deepEqual(out.workloads, []);
    assert.deepEqual(out.ingresses, []);
    assert.deepEqual(out.pvcs, []);
    assert.deepEqual(out.nodes, []);
  });

  it('groups containers by workload (kind+name) and aggregates pod counts', () => {
    // Two pods of the same Deployment, one container each
    seedK8sContainer(db, {
      hostId: 'k3d-server', containerName: 'default/web/nginx',
      containerId: 'uid-1/web/nginx', workloadKind: 'Deployment', health: 'healthy',
    });
    seedK8sContainer(db, {
      hostId: 'k3d-worker', containerName: 'default/web/nginx',
      containerId: 'uid-2/web/nginx', workloadKind: 'Deployment', health: 'unhealthy',
    });
    // A separate StatefulSet pod
    seedK8sContainer(db, {
      hostId: 'k3d-server', containerName: 'default/db-0/postgres',
      containerId: 'uid-3/db-0/postgres', workloadKind: 'StatefulSet', health: 'healthy',
    });

    const topo = getNamespaceTopology(db, 'prod', 'default', 15);
    assert.equal(topo.workloads.length, 2);

    const web = topo.workloads.find((w: any) => w.name === 'web')!;
    assert.equal(web.kind, 'Deployment');
    assert.equal(web.total_pods, 2);
    assert.equal(web.unhealthy_pods, 1, 'one pod has an unhealthy container');
    assert.deepEqual(web.pods_by_node, { 'k3d-server': 1, 'k3d-worker': 1 });

    const db0 = topo.workloads.find((w: any) => w.name === 'db-0')!;
    assert.equal(db0.kind, 'StatefulSet');
    assert.equal(db0.total_pods, 1);
    assert.equal(db0.unhealthy_pods, 0);
  });

  it('counts multiple containers in the same pod (same podUid) as one pod', () => {
    seedK8sContainer(db, {
      hostId: 'k3d-server', containerName: 'default/web/nginx',
      containerId: 'uid-1/web/nginx', workloadKind: 'Deployment', health: 'healthy',
    });
    seedK8sContainer(db, {
      hostId: 'k3d-server', containerName: 'default/web/sidecar',
      containerId: 'uid-1/web/sidecar', workloadKind: 'Deployment', health: 'healthy',
    });
    const topo = getNamespaceTopology(db, 'prod', 'default', 15);
    const web = topo.workloads[0];
    assert.equal(web.total_pods, 1, 'sidecars share the pod_uid');
    assert.equal(web.pods[0].containers.length, 2);
  });

  it('scopes containers to the cluster_id and namespace prefix', () => {
    // Same pod name but different namespace — must not bleed into "default"
    seedK8sContainer(db, {
      hostId: 'k3d-server', containerName: 'kube-system/coredns/coredns',
      containerId: 'uid-9/coredns/coredns', workloadKind: 'Deployment', health: 'healthy',
    });
    const topo = getNamespaceTopology(db, 'prod', 'default', 15);
    assert.equal(topo.workloads.length, 0);

    const topo2 = getNamespaceTopology(db, 'prod', 'kube-system', 15);
    assert.equal(topo2.workloads.length, 1);
    assert.equal(topo2.workloads[0].name, 'coredns');
  });

  it('includes ingresses scoped to (cluster_id, namespace) only', () => {
    db.prepare(`
      INSERT INTO k8s_ingresses (cluster_id, namespace, name, ingress_class, hosts, paths, tls_hosts, external_ip, created_at, labels)
      VALUES ('prod', 'default', 'web-ing', null, '["app.local"]', '[{"host":"app.local","path":"/","serviceName":"web","servicePort":80}]', null, null, null, null)
    `).run();
    db.prepare(`
      INSERT INTO k8s_ingresses (cluster_id, namespace, name, ingress_class, hosts, paths, tls_hosts, external_ip, created_at, labels)
      VALUES ('prod', 'kube-system', 'kibana-ing', null, '["k.local"]', '[{"host":"k.local","path":"/","serviceName":"kibana","servicePort":80}]', null, null, null, null)
    `).run();
    const topo = getNamespaceTopology(db, 'prod', 'default', 15);
    assert.equal(topo.ingresses.length, 1);
    assert.equal(topo.ingresses[0].name, 'web-ing');
    assert.deepEqual(topo.ingresses[0].service_targets, ['web']);
    assert.deepEqual(topo.ingresses[0].hosts, ['app.local']);
  });

  it('includes only the latest snapshot per (cluster_id, namespace, pvc_name)', () => {
    db.prepare(`INSERT INTO pvc_snapshots (cluster_id, namespace, pvc_name, phase, capacity_bytes, storage_class, collected_at)
                VALUES ('prod','default','data','Pending', null, 'local', datetime('now', '-1 hour'))`).run();
    db.prepare(`INSERT INTO pvc_snapshots (cluster_id, namespace, pvc_name, phase, capacity_bytes, storage_class, collected_at)
                VALUES ('prod','default','data','Bound', 5368709120, 'local', datetime('now'))`).run();
    const topo = getNamespaceTopology(db, 'prod', 'default', 15);
    assert.equal(topo.pvcs.length, 1);
    assert.equal(topo.pvcs[0].phase, 'Bound', 'latest snapshot wins');
    assert.equal(topo.pvcs[0].capacity_bytes, 5368709120);
  });

  it('lists nodes hosting at least one pod in the namespace, with pod counts', () => {
    seedK8sContainer(db, {
      hostId: 'k3d-server', containerName: 'default/web/nginx',
      containerId: 'uid-1/web/nginx', workloadKind: 'Deployment', health: 'healthy',
    });
    seedK8sContainer(db, {
      hostId: 'k3d-server', containerName: 'default/web/nginx',
      containerId: 'uid-1/web/nginx', workloadKind: 'Deployment', health: 'healthy',
    });
    seedK8sContainer(db, {
      hostId: 'k3d-worker', containerName: 'default/db-0/postgres',
      containerId: 'uid-3/db-0/postgres', workloadKind: 'StatefulSet', health: 'healthy',
    });
    const topo = getNamespaceTopology(db, 'prod', 'default', 15);
    assert.equal(topo.nodes.length, 2);
    const byHost = Object.fromEntries(topo.nodes.map((n: any) => [n.host_id, n.pod_count]));
    assert.deepEqual(byHost, { 'k3d-server': 1, 'k3d-worker': 1 });
  });
});
