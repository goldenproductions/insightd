import { useMemo, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  Position,
  type Edge,
  type Node,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import type {
  NamespaceTopology,
  TopologyWorkload,
  TopologyIngress,
  TopologyNode,
  TopologyPvc,
  TopologyPod,
} from '@/types/api';
import { Card } from '@/components/Card';
import { BackLink } from '@/components/BackLink';
import { PageTitle } from '@/components/PageTitle';
import { LoadingState } from '@/components/LoadingState';
import { EmptyState } from '@/components/EmptyState';

// ── Layout ──────────────────────────────────────────────────────────────────
//
// A horizontal three-column layout: Ingresses (left) → Workloads (center) →
// Nodes (right). Edges run left-to-right. The graph is fully laid out by
// hand — react-flow only does rendering + interaction, not layout. Hand-
// computed positions are good enough for the small namespaces a homelab
// typically runs (≤30 workloads); past that we can swap in dagre or elk.

const COL_X = { ingress: 0, workload: 360, node: 760 };
const Y_STEP = 90;
const Y_TOP = 40;

// ── Heuristic Ingress→Workload matching ─────────────────────────────────────
//
// We don't ingest k8s Services today (only Ingresses), so to draw an
// Ingress→Workload edge we match the ingress's `paths[].serviceName` against
// workload names by simple equality first, then by prefix. This catches the
// common pattern where a Service has the same name as its parent Deployment
// (e.g. `frontend` Service → `frontend` Deployment), which Helm + most
// hand-rolled charts default to.

function matchIngressToWorkloads(
  ingresses: TopologyIngress[],
  workloads: TopologyWorkload[],
): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>();
  const workloadKeys = new Map(workloads.map(w => [w.name, workloadKeyOf(w)]));

  for (const ing of ingresses) {
    const matches = new Set<string>();
    for (const target of ing.service_targets) {
      // Exact match first.
      if (workloadKeys.has(target)) {
        matches.add(workloadKeys.get(target)!);
        continue;
      }
      // Prefix fallback — the Service might be `foo-svc` against a
      // `foo` workload. Conservative: only when the workload name is a
      // strict prefix of the service name with a dash boundary.
      for (const wl of workloads) {
        if (target.startsWith(`${wl.name}-`)) {
          matches.add(workloadKeyOf(wl));
        }
      }
    }
    if (matches.size > 0) out.set(ing.id, matches);
  }
  return out;
}

function workloadKeyOf(wl: { kind: string | null; name: string }): string {
  return `wl:${wl.kind ?? '_'}:${wl.name}`;
}

function ingressKeyOf(ing: { id: number }): string {
  return `ing:${ing.id}`;
}

function nodeKeyOf(n: { host_id: string }): string {
  return `node:${n.host_id}`;
}

// ── React-Flow custom node renderers ────────────────────────────────────────
//
// Custom node components stay simple — we render Tailwind boxes; react-flow
// handles connection points via the Position handles below.

interface WorkloadCardData {
  workload: TopologyWorkload;
  onClick: () => void;
  active: boolean;
}

function WorkloadCard({ data }: { data: WorkloadCardData }) {
  const { workload: wl, onClick, active } = data;
  const tone = wl.unhealthy_pods > 0
    ? 'border-warning/60 bg-warning/5'
    : 'border-success/40 bg-success/5';
  return (
    <button
      onClick={onClick}
      className={`flex min-w-[280px] flex-col items-start rounded-lg border p-3 text-left shadow-sm transition-colors ${tone} ${active ? 'ring-2 ring-info' : ''}`}
    >
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">
        {wl.kind ?? 'Standalone pod'}
      </div>
      <div className="mt-0.5 truncate font-mono text-sm font-bold text-fg" title={wl.name}>
        {wl.name}
      </div>
      <div className="mt-2 flex items-center gap-3 text-xs">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-success" />
          <span className="text-fg">{wl.total_pods - wl.unhealthy_pods}</span>
          <span className="text-muted">healthy</span>
        </span>
        {wl.unhealthy_pods > 0 && (
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-warning" />
            <span className="text-fg">{wl.unhealthy_pods}</span>
            <span className="text-muted">unhealthy</span>
          </span>
        )}
      </div>
    </button>
  );
}

function IngressCard({ data }: { data: { ingress: TopologyIngress } }) {
  const { ingress } = data;
  return (
    <div className="flex min-w-[220px] flex-col rounded-lg border border-info/40 bg-info/5 p-3 shadow-sm">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-info">
        Ingress
      </div>
      <div className="mt-0.5 truncate font-mono text-sm font-bold text-fg" title={ingress.name}>
        {ingress.name}
      </div>
      {ingress.hosts.length > 0 && (
        <div className="mt-1 truncate text-[11px] text-muted" title={ingress.hosts.join(', ')}>
          {ingress.hosts[0]}{ingress.hosts.length > 1 && ` +${ingress.hosts.length - 1}`}
        </div>
      )}
    </div>
  );
}

function NodeCard({ data }: { data: { node: TopologyNode } }) {
  const { node } = data;
  const tone = node.online ? 'border-border bg-surface' : 'border-warning/40 bg-warning/5';
  return (
    <Link
      to={`/hosts/${encodeURIComponent(node.host_id)}`}
      className={`flex min-w-[200px] flex-col rounded-lg border p-3 shadow-sm transition-colors hover:bg-bg-secondary ${tone}`}
    >
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">
        Node {!node.online && '(offline)'}
      </div>
      <div className="mt-0.5 truncate font-mono text-sm font-bold text-fg" title={node.host_id}>
        {node.host_id}
      </div>
      <div className="mt-1 text-[11px] text-muted">
        {node.pod_count} pod{node.pod_count === 1 ? '' : 's'}
      </div>
    </Link>
  );
}

const NODE_TYPES = {
  workload: WorkloadCard,
  ingress: IngressCard,
  k8sNode: NodeCard,
};

// ── Build nodes + edges ─────────────────────────────────────────────────────

function buildGraph(
  topo: NamespaceTopology,
  selected: string | null,
  setSelected: (k: string | null) => void,
): { nodes: Node[]; edges: Edge[] } {
  const ingressMatches = matchIngressToWorkloads(topo.ingresses, topo.workloads);

  const nodes: Node[] = [];
  const edges: Edge[] = [];

  topo.ingresses.forEach((ing, i) => {
    nodes.push({
      id: ingressKeyOf(ing),
      type: 'ingress',
      position: { x: COL_X.ingress, y: Y_TOP + i * Y_STEP },
      data: { ingress: ing },
      sourcePosition: Position.Right,
    });
  });

  topo.workloads.forEach((wl, i) => {
    const key = workloadKeyOf(wl);
    nodes.push({
      id: key,
      type: 'workload',
      position: { x: COL_X.workload, y: Y_TOP + i * Y_STEP },
      data: {
        workload: wl,
        onClick: () => setSelected(selected === key ? null : key),
        active: selected === key,
      },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    });
  });

  topo.nodes.forEach((n, i) => {
    nodes.push({
      id: nodeKeyOf(n),
      type: 'k8sNode',
      position: { x: COL_X.node, y: Y_TOP + i * Y_STEP },
      data: { node: n },
      targetPosition: Position.Left,
    });
  });

  // Ingress → Workload edges (heuristic).
  for (const [ingId, workloadKeys] of ingressMatches) {
    for (const wlKey of workloadKeys) {
      edges.push({
        id: `e:ing-${ingId}->${wlKey}`,
        source: ingressKeyOf({ id: ingId }),
        target: wlKey,
        animated: true,
        style: { stroke: 'var(--color-info)', strokeWidth: 1.5 },
      });
    }
  }

  // Workload → Node edges (one per (workload, node) pair, weighted by pod count).
  for (const wl of topo.workloads) {
    const wlKey = workloadKeyOf(wl);
    for (const [hostId, count] of Object.entries(wl.pods_by_node)) {
      edges.push({
        id: `e:${wlKey}->node-${hostId}`,
        source: wlKey,
        target: nodeKeyOf({ host_id: hostId }),
        label: count > 1 ? `×${count}` : undefined,
        labelStyle: { fontSize: 10 },
        labelBgStyle: { fill: 'var(--color-bg)' },
        style: {
          stroke: 'var(--color-border)',
          strokeWidth: Math.min(3, 1 + count * 0.4),
        },
      });
    }
  }

  return { nodes, edges };
}

// ── Side panel ──────────────────────────────────────────────────────────────

function SidePanel({
  workload,
  topo,
  onClose,
}: {
  workload: TopologyWorkload | null;
  topo: NamespaceTopology;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  if (!workload) {
    return (
      <Card title="Namespace summary">
        <ul className="space-y-1 text-sm">
          <li><span className="text-muted">Workloads:</span> {topo.workloads.length}</li>
          <li><span className="text-muted">Pods:</span> {topo.workloads.reduce((s, w) => s + w.total_pods, 0)}</li>
          <li><span className="text-muted">Ingresses:</span> {topo.ingresses.length}</li>
          <li><span className="text-muted">PVCs:</span> {topo.pvcs.length}</li>
          <li><span className="text-muted">Nodes hosting pods:</span> {topo.nodes.length}</li>
        </ul>
        <p className="mt-3 text-[11px] text-muted">
          Click a workload to inspect its pods.
        </p>
      </Card>
    );
  }

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">
            {workload.kind ?? 'Standalone pod'}
          </span>
          <span className="font-mono">{workload.name}</span>
        </span>
      }
      actions={
        <button onClick={onClose} className="text-xs text-muted hover:text-fg" title="Close">
          ✕
        </button>
      }
    >
      <ul className="space-y-2 text-sm">
        {workload.pods.map(pod => <PodRow key={pod.pod_uid} pod={pod} navigate={navigate} />)}
      </ul>
    </Card>
  );
}

function PodRow({ pod, navigate }: { pod: TopologyPod; navigate: ReturnType<typeof useNavigate> }) {
  const unhealthy = pod.containers.some(c => c.health_status === 'unhealthy' || c.has_active_alert);
  const tone = unhealthy ? 'border-warning/40' : 'border-border';
  return (
    <li className={`rounded border ${tone} bg-bg-secondary/40 p-2`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] text-muted" title={pod.pod_uid}>
          pod {pod.pod_uid.slice(0, 8)}
        </span>
        <Link to={`/hosts/${encodeURIComponent(pod.host_id)}`} className="text-[11px] text-info hover:underline">
          {pod.host_id}
        </Link>
      </div>
      <ul className="mt-1.5 space-y-0.5">
        {pod.containers.map(c => (
          <li key={c.container_name} className="flex items-center gap-2 text-xs">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              c.has_active_alert ? 'bg-danger'
              : c.health_status === 'unhealthy' ? 'bg-warning'
              : c.health_status === 'starting' ? 'bg-info'
              : 'bg-success/60'
            }`} />
            <button
              type="button"
              onClick={() => navigate(`/hosts/${encodeURIComponent(pod.host_id)}/containers/${encodeURIComponent(c.container_name)}`)}
              className="truncate text-fg hover:underline"
              title={c.container_name}
            >
              {c.container || '(no container segment)'}
            </button>
            <span className="ml-auto text-[10px] text-muted">{c.status}</span>
          </li>
        ))}
      </ul>
    </li>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

export function TopologyPage() {
  const { clusterId, namespace } = useParams();
  const [selected, setSelected] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.namespaceTopology(clusterId, namespace),
    queryFn: () => api<NamespaceTopology>(
      `/clusters/${encodeURIComponent(clusterId!)}/namespaces/${encodeURIComponent(namespace!)}/topology`,
    ),
    refetchInterval: 30_000,
  });

  const graph = useMemo(() => {
    if (!data) return { nodes: [], edges: [] };
    return buildGraph(data, selected, setSelected);
  }, [data, selected]);

  const selectedWorkload = useMemo(() => {
    if (!data || !selected) return null;
    return data.workloads.find(w => workloadKeyOf(w) === selected) ?? null;
  }, [data, selected]);

  if (isLoading) return <LoadingState />;
  if (!data) return <EmptyState message="No topology data" />;

  const isEmpty = data.workloads.length === 0 && data.ingresses.length === 0;

  return (
    <div className="animate-fade-in space-y-4">
      <div className="flex items-center justify-between gap-3">
        <BackLink to={`/hosts`} label="Back to Hosts" />
      </div>
      <PageTitle subtitle="Namespace topology">
        <span className="flex items-center gap-2">
          <span>{data.namespace}</span>
          <span className="rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted">
            {data.cluster_id}
          </span>
        </span>
      </PageTitle>

      {isEmpty ? (
        <EmptyState message="No workloads or ingresses observed in this namespace." />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
          <div className="rounded-xl border border-border bg-surface" style={{ height: '70vh', minHeight: 480 }}>
            <ReactFlow
              nodes={graph.nodes}
              edges={graph.edges}
              nodeTypes={NODE_TYPES}
              fitView
              fitViewOptions={{ padding: 0.2 }}
              proOptions={{ hideAttribution: true }}
              nodesDraggable={false}
              nodesConnectable={false}
              edgesFocusable={false}
              panOnDrag
              zoomOnScroll
            >
              <Background gap={20} />
              <Controls showInteractive={false} />
              <MiniMap pannable zoomable nodeStrokeWidth={2} />
            </ReactFlow>
          </div>
          <div className="space-y-4">
            <SidePanel workload={selectedWorkload} topo={data} onClose={() => setSelected(null)} />
            {data.pvcs.length > 0 && (
              <Card title={<>PVCs <span className="ml-1 text-xs font-normal text-muted">({data.pvcs.length})</span></>}>
                <ul className="space-y-1.5 text-sm">
                  {data.pvcs.map(pvc => <PvcRow key={pvc.name} pvc={pvc} />)}
                </ul>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function PvcRow({ pvc }: { pvc: TopologyPvc }) {
  const phaseTone = pvc.phase === 'Bound' ? 'text-success'
    : pvc.phase === 'Pending' ? 'text-warning'
    : 'text-muted';
  return (
    <li className="flex items-center justify-between gap-2">
      <span className="truncate font-mono text-fg" title={pvc.name}>{pvc.name}</span>
      <span className={`text-[11px] ${phaseTone}`}>{pvc.phase}</span>
    </li>
  );
}
