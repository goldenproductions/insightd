import { useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import type { ClusterOverview, ClusterNamespaceSummary, ClusterNode } from '@/types/api';
import { Card } from '@/components/Card';
import { BackLink } from '@/components/BackLink';
import { PageTitle } from '@/components/PageTitle';
import { LoadingState } from '@/components/LoadingState';
import { EmptyState } from '@/components/EmptyState';

export function ClusterOverviewPage() {
  const { clusterId } = useParams();
  const [search, setSearch] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.clusterOverview(clusterId),
    queryFn: () => api<ClusterOverview>(`/clusters/${encodeURIComponent(clusterId!)}/overview`),
    refetchInterval: 30_000,
  });

  const filteredNamespaces = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    if (!q) return data.namespaces;
    return data.namespaces.filter(n => n.namespace.toLowerCase().includes(q));
  }, [data, search]);

  if (isLoading) return <LoadingState />;
  if (!data) return <EmptyState message="No data for this cluster." />;

  const isEmpty = data.namespaces.length === 0 && data.nodes.length === 0;

  return (
    <div className="animate-fade-in space-y-6">
      <BackLink to="/hosts" label="Back to Hosts" />
      <PageTitle subtitle="Kubernetes cluster overview">
        <span className="flex items-center gap-2">
          <span>{data.cluster_id}</span>
        </span>
      </PageTitle>

      {isEmpty ? (
        <EmptyState message="No nodes or namespaces observed in this cluster yet." />
      ) : (
        <>
          <ClusterHeroStats overview={data} />
          <NodeStrip nodes={data.nodes} />

          <Card
            title={
              <span className="flex items-center gap-2">
                <span>Namespaces</span>
                <span className="text-xs font-normal text-muted">({filteredNamespaces.length})</span>
              </span>
            }
            actions={
              <input
                type="text"
                placeholder="Search namespaces…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-48 rounded border border-border bg-surface px-2 py-1 text-xs placeholder:text-muted focus:border-info focus:outline-none"
              />
            }
          >
            {filteredNamespaces.length === 0 ? (
              <p className="text-sm text-muted">No namespaces match.</p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {filteredNamespaces.map(ns => (
                  <NamespaceCard key={ns.namespace} ns={ns} clusterId={data.cluster_id} />
                ))}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

// ── Hero stats ──────────────────────────────────────────────────────────────

function ClusterHeroStats({ overview }: { overview: ClusterOverview }) {
  const t = overview.totals;
  const podsTone = t.unhealthy_pods === 0 ? 'text-success' : 'text-warning';
  const alertsTone = t.active_alerts === 0 ? 'text-success' : t.active_alerts > 5 ? 'text-danger' : 'text-warning';

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Stat
        label="Nodes"
        value={`${t.nodes_online}/${t.nodes_online + t.nodes_offline}`}
        sub={t.nodes_offline > 0 ? `${t.nodes_offline} offline` : 'all online'}
        tone={t.nodes_offline > 0 ? 'text-warning' : 'text-success'}
      />
      <Stat
        label="Workloads"
        value={String(t.workloads)}
        sub={`${t.namespaces} namespace${t.namespaces === 1 ? '' : 's'}`}
        tone="text-fg"
      />
      <Stat
        label="Pods"
        value={String(t.pods)}
        sub={t.unhealthy_pods === 0 ? 'all healthy' : `${t.unhealthy_pods} unhealthy`}
        tone={podsTone}
      />
      <Link
        to={t.active_alerts > 0 ? `/alerts?levels=critical,error,warning&q=${encodeURIComponent(overview.cluster_id)}` : '/alerts'}
        className="block"
      >
        <Stat
          label="Active alerts"
          value={String(t.active_alerts)}
          sub={`${t.ingresses} ingress · ${t.pvcs} PVC${t.pvcs_pending > 0 ? ` (${t.pvcs_pending} pending)` : ''}`}
          tone={alertsTone}
          interactive
        />
      </Link>
    </div>
  );
}

function Stat({ label, value, sub, tone, interactive }: {
  label: string;
  value: string;
  sub: string;
  tone: string;
  interactive?: boolean;
}) {
  return (
    <div className={`rounded-lg border border-border bg-surface px-4 py-3 ${interactive ? 'transition-colors hover:bg-bg-secondary' : ''}`}>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className={`mt-0.5 text-2xl font-bold tabular-nums ${tone}`}>{value}</div>
      <div className="mt-0.5 text-[11px] text-muted">{sub}</div>
    </div>
  );
}

// ── Node strip ──────────────────────────────────────────────────────────────

function NodeStrip({ nodes }: { nodes: ClusterNode[] }) {
  if (nodes.length === 0) return null;
  return (
    <Card title="Nodes">
      <div className="flex flex-wrap gap-2">
        {nodes.map(n => (
          <Link
            key={n.host_id}
            to={`/hosts/${encodeURIComponent(n.host_id)}`}
            className={`flex items-center gap-2 rounded border px-3 py-1.5 text-sm transition-colors ${
              n.online
                ? 'border-border bg-bg-secondary/40 hover:border-info/40 hover:bg-info/5'
                : 'border-warning/40 bg-warning/5 hover:bg-warning/10'
            }`}
            title={n.online ? 'Online' : 'Offline'}
          >
            <span className={`h-2 w-2 rounded-full ${n.online ? 'bg-success' : 'bg-warning'}`} />
            <span className="font-mono text-fg">{n.host_id}</span>
            <span className="text-[11px] text-muted">{n.pod_count} pod{n.pod_count === 1 ? '' : 's'}</span>
          </Link>
        ))}
      </div>
    </Card>
  );
}

// ── Namespace card ──────────────────────────────────────────────────────────

function NamespaceCard({ ns, clusterId }: { ns: ClusterNamespaceSummary; clusterId: string }) {
  const tone = ns.unhealthy_pod_count > 0 || ns.active_alert_count > 0
    ? 'border-warning/40 bg-warning/5'
    : 'border-border bg-bg-secondary/30';

  return (
    <Link
      to={`/clusters/${encodeURIComponent(clusterId)}/namespaces/${encodeURIComponent(ns.namespace)}/topology`}
      className={`flex flex-col gap-2 rounded-lg border p-3 transition-colors hover:border-info/40 hover:bg-info/5 ${tone}`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate font-mono text-sm font-bold text-fg" title={ns.namespace}>
          {ns.namespace}
        </span>
        <span className="shrink-0 text-[11px] text-info">Topology →</span>
      </div>

      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
        <Counter label="workload" plural="workloads" value={ns.workload_count} />
        <PodCounter healthy={ns.pod_count - ns.unhealthy_pod_count} unhealthy={ns.unhealthy_pod_count} />
      </div>

      {(ns.ingress_count > 0 || ns.pvc_count > 0 || ns.active_alert_count > 0) && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-border/60 pt-1.5 text-[11px] text-muted">
          {ns.ingress_count > 0 && <span>{ns.ingress_count} ingress{ns.ingress_count === 1 ? '' : 'es'}</span>}
          {ns.pvc_count > 0 && (
            <span>
              {ns.pvc_count} PVC{ns.pvc_count === 1 ? '' : 's'}
              {ns.pvc_pending_count > 0 && <span className="text-warning"> ({ns.pvc_pending_count} pending)</span>}
            </span>
          )}
          {ns.active_alert_count > 0 && (
            <span className="text-warning">
              {ns.active_alert_count} active alert{ns.active_alert_count === 1 ? '' : 's'}
            </span>
          )}
        </div>
      )}
    </Link>
  );
}

function Counter({ label, plural, value }: { label: string; plural: string; value: number }) {
  return (
    <span>
      <span className="font-semibold text-fg tabular-nums">{value}</span>
      <span className="ml-1 text-muted">{value === 1 ? label : plural}</span>
    </span>
  );
}

function PodCounter({ healthy, unhealthy }: { healthy: number; unhealthy: number }) {
  const total = healthy + unhealthy;
  return (
    <span title={`${healthy} healthy, ${unhealthy} unhealthy`}>
      <span className="font-semibold text-fg tabular-nums">{total}</span>
      <span className="ml-1 text-muted">pod{total === 1 ? '' : 's'}</span>
      {unhealthy > 0 && (
        <>
          <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-warning align-middle" />
          <span className="ml-1 text-warning tabular-nums">{unhealthy}</span>
        </>
      )}
    </span>
  );
}
