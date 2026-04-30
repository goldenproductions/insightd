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
  TopologyService,
  TopologySeverity,
  TopologyAlert,
  TopologyFinding,
} from '@/types/api';
import { Card } from '@/components/Card';
import { BackLink } from '@/components/BackLink';
import { PageTitle } from '@/components/PageTitle';
import { LoadingState } from '@/components/LoadingState';
import { EmptyState } from '@/components/EmptyState';

// ── Layout ──────────────────────────────────────────────────────────────────
//
// A horizontal four-column layout:
//   Ingresses (left) → Services → Workloads → Nodes (right).
// Edges run left-to-right and follow the real k8s plumbing:
//   Ingress.paths[].serviceName  → Service node by exact namespace+name match
//   Service.selector ⊆ pod_labels → Workload nodes (computed server-side,
//                                   surfaced as service.workload_keys)
//   Workload                     → Node (one edge per node hosting a pod,
//                                   weighted by pod count)
// The graph is laid out by hand; react-flow only renders + handles
// interaction. Good enough for the small namespaces a homelab typically
// runs (≤30 workloads); past that we can swap in dagre or elk.

const COL_X = { ingress: 0, service: 320, workload: 660, node: 1040 };
const Y_STEP = 90;
const Y_TOP = 40;

function workloadKeyOf(wl: { kind: string | null; name: string }): string {
  return `wl:${wl.kind ?? '_'}:${wl.name}`;
}

function serviceKeyOf(s: { name: string }): string {
  return `svc:${s.name}`;
}

function ingressKeyOf(ing: { id: number }): string {
  return `ing:${ing.id}`;
}

function nodeKeyOf(n: { host_id: string }): string {
  return `node:${n.host_id}`;
}

const SEVERITY_RANK: Record<string, number> = { warning: 1, error: 2, critical: 3 };

/** Highest severity across the given workload keys. null when none of the
 *  backends has any active alerts/findings. Used to propagate tone from
 *  Workload cards to the Service that fronts them. */
function worstBackendSeverity(workloadKeys: string[], severityByKey: Map<string, TopologySeverity>): TopologySeverity {
  let worst: TopologySeverity = null;
  let worstRank = 0;
  for (const k of workloadKeys) {
    const sev = severityByKey.get(k) ?? null;
    if (!sev) continue;
    const rank = SEVERITY_RANK[sev] ?? 0;
    if (rank > worstRank) { worstRank = rank; worst = sev; }
  }
  return worst;
}

/** Match Ingress→Service by exact serviceName lookup. Pre-computes a
 *  service-name index so each ingress costs O(N_targets). */
function matchIngressesToServices(
  ingresses: TopologyIngress[],
  services: TopologyService[],
): Map<number, Set<string>> {
  const byName = new Map(services.map(s => [s.name, serviceKeyOf(s)]));
  const out = new Map<number, Set<string>>();
  for (const ing of ingresses) {
    const matches = new Set<string>();
    for (const target of ing.service_targets) {
      const key = byName.get(target);
      if (key) matches.add(key);
    }
    if (matches.size > 0) out.set(ing.id, matches);
  }
  return out;
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

/** Severity-tiered tone classes for the workload card. critical → red,
 *  error → amber, warning → blue, calm (null) → green. */
const WORKLOAD_TONE_BY_SEVERITY: Record<string, string> = {
  critical: 'border-danger/60 bg-danger/5',
  error: 'border-warning/60 bg-warning/5',
  warning: 'border-info/40 bg-info/5',
};

const BADGE_TONE_BY_SEVERITY: Record<string, string> = {
  critical: 'border-danger/40 bg-danger/10 text-danger',
  error: 'border-warning/40 bg-warning/10 text-warning',
  warning: 'border-info/40 bg-info/10 text-info',
};

function WorkloadCard({ data }: { data: WorkloadCardData }) {
  const { workload: wl, onClick, active } = data;
  const sev = wl.severity ?? null;
  const tone = sev
    ? WORKLOAD_TONE_BY_SEVERITY[sev]
    : 'border-success/40 bg-success/5';
  const issueCount = wl.active_alerts.length + wl.findings.length;
  return (
    <button
      onClick={onClick}
      className={`flex min-w-[280px] flex-col items-start rounded-lg border p-3 text-left shadow-sm transition-colors ${tone} ${active ? 'ring-2 ring-info' : ''}`}
    >
      <div className="flex w-full items-baseline justify-between gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">
          {wl.kind ?? 'Standalone pod'}
        </div>
        {sev && issueCount > 0 && (
          <span
            className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${BADGE_TONE_BY_SEVERITY[sev]}`}
            title={`${wl.active_alerts.length} alert${wl.active_alerts.length === 1 ? '' : 's'}, ${wl.findings.length} finding${wl.findings.length === 1 ? '' : 's'} — click to view`}
          >
            {sev === 'critical' ? '⛔' : sev === 'error' ? '⚠' : 'ℹ'} {issueCount}
          </span>
        )}
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

interface ServiceCardData {
  service: TopologyService;
  onClick: () => void;
  active: boolean;
  /** Worst severity of any backing workload — propagates tone up the graph
   *  when all of a service's pods are unhealthy. null when calm. */
  backendSeverity: TopologySeverity;
}

function ServiceCard({ data }: { data: ServiceCardData }) {
  const { service: s, onClick, active, backendSeverity } = data;
  // Service tone:
  //   - warning if type=ExternalName + leaf services with no pod backends
  //     (selector matched nothing → operator probably wants to see this)
  //   - if backing workloads are sick, tint the service to match the worst
  //     backend severity (red/amber/blue)
  //   - otherwise calm purple to distinguish from Workloads.
  const noBackends = s.is_external || s.workload_keys.length === 0;
  const isExternalName = s.type === 'ExternalName';
  const tone = isExternalName
    ? 'border-info/40 bg-info/5'
    : noBackends
      ? 'border-warning/40 bg-warning/5'
      : backendSeverity
        ? WORKLOAD_TONE_BY_SEVERITY[backendSeverity]
        : 'border-purple-400/40 bg-purple-500/5';
  const portSummary = s.ports.length === 0
    ? '—'
    : s.ports.slice(0, 2).map(p => `${p.port}${p.target_port != null && String(p.target_port) !== String(p.port) ? `→${p.target_port}` : ''}`).join(', ')
      + (s.ports.length > 2 ? ` +${s.ports.length - 2}` : '');

  return (
    <button
      onClick={onClick}
      className={`flex min-w-[220px] flex-col items-start rounded-lg border p-3 text-left shadow-sm transition-colors ${tone} ${active ? 'ring-2 ring-info' : ''}`}
    >
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">
        Service · {s.type}
      </div>
      <div className="mt-0.5 truncate font-mono text-sm font-bold text-fg" title={s.name}>
        {s.name}
      </div>
      <div className="mt-1 text-[11px] text-muted">
        {isExternalName && s.external_name ? `→ ${s.external_name}` : `ports ${portSummary}`}
      </div>
      {noBackends && !isExternalName && (
        <div className="mt-0.5 text-[10px] text-warning">no pod backends</div>
      )}
    </button>
  );
}

const NODE_TYPES = {
  workload: WorkloadCard,
  ingress: IngressCard,
  k8sNode: NodeCard,
  service: ServiceCard,
};

// ── Build nodes + edges ─────────────────────────────────────────────────────

function buildGraph(
  topo: NamespaceTopology,
  selected: string | null,
  setSelected: (k: string | null) => void,
): { nodes: Node[]; edges: Edge[] } {
  const ingressToService = matchIngressesToServices(topo.ingresses, topo.services);

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

  // Index workload severities so service tones can propagate from their
  // backing workloads. A service inherits the worst severity across its
  // backends.
  const workloadSeverityByKey = new Map<string, TopologySeverity>(
    topo.workloads.map(w => [workloadKeyOf(w), w.severity]),
  );
  topo.services.forEach((s, i) => {
    const key = serviceKeyOf(s);
    const backendSeverity = worstBackendSeverity(s.workload_keys, workloadSeverityByKey);
    nodes.push({
      id: key,
      type: 'service',
      position: { x: COL_X.service, y: Y_TOP + i * Y_STEP },
      data: {
        service: s,
        backendSeverity,
        onClick: () => setSelected(selected === key ? null : key),
        active: selected === key,
      },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
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

  // Ingress → Service edges (real, by serviceName match).
  for (const [ingId, svcKeys] of ingressToService) {
    for (const svcKey of svcKeys) {
      edges.push({
        id: `e:ing-${ingId}->${svcKey}`,
        source: ingressKeyOf({ id: ingId }),
        target: svcKey,
        animated: true,
        style: { stroke: 'var(--color-info)', strokeWidth: 1.5 },
      });
    }
  }

  // Service → Workload edges (real, via selector ⊆ pod_labels — computed
  // server-side and surfaced as service.workload_keys).
  for (const s of topo.services) {
    const svcKey = serviceKeyOf(s);
    for (const wlKey of s.workload_keys) {
      edges.push({
        id: `e:${svcKey}->${wlKey}`,
        source: svcKey,
        target: wlKey,
        style: { stroke: 'var(--color-purple, #a855f7)', strokeWidth: 1.5 },
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

  // RCA neighbor overlay — only when the selected workload has issues. Draws
  // intra-namespace metric_corr edges (computed server-side) as dashed lines
  // anchored to the right side of each workload node so they don't overlap
  // with the Service→Workload edges incoming from the left.
  const selectedWl = selected && topo.workloads.find(w => workloadKeyOf(w) === selected);
  if (selectedWl && selectedWl.severity) {
    for (const e of topo.rca_edges) {
      if (e.from !== selected && e.to !== selected) continue;
      edges.push({
        id: `rca:${e.from}->${e.to}`,
        source: e.from,
        target: e.to,
        sourceHandle: undefined,
        animated: false,
        style: {
          stroke: 'var(--color-warning)',
          strokeWidth: Math.max(1, e.weight * 2),
          strokeDasharray: '5 4',
          opacity: 0.7,
        },
        label: `corr ${e.weight.toFixed(2)}`,
        labelStyle: { fontSize: 9, fill: 'var(--color-warning)' },
        labelBgStyle: { fill: 'var(--color-bg)' },
      });
    }
  }

  return { nodes, edges };
}

// ── Side panel ──────────────────────────────────────────────────────────────

function SidePanel({
  workload,
  service,
  topo,
  onClose,
}: {
  workload: TopologyWorkload | null;
  service: TopologyService | null;
  topo: NamespaceTopology;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  if (!workload && !service) {
    return (
      <Card title="Namespace summary">
        <ul className="space-y-1 text-sm">
          <li><span className="text-muted">Workloads:</span> {topo.workloads.length}</li>
          <li><span className="text-muted">Pods:</span> {topo.workloads.reduce((s, w) => s + w.total_pods, 0)}</li>
          <li><span className="text-muted">Services:</span> {topo.services.length}</li>
          <li><span className="text-muted">Ingresses:</span> {topo.ingresses.length}</li>
          <li><span className="text-muted">PVCs:</span> {topo.pvcs.length}</li>
          <li><span className="text-muted">Nodes hosting pods:</span> {topo.nodes.length}</li>
        </ul>
        <p className="mt-3 text-[11px] text-muted">
          Click a workload or service to inspect it.
        </p>
      </Card>
    );
  }

  if (service) {
    return <ServiceDetail service={service} topo={topo} onClose={onClose} />;
  }

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">
            {workload!.kind ?? 'Standalone pod'}
          </span>
          <span className="font-mono">{workload!.name}</span>
        </span>
      }
      actions={
        <button onClick={onClose} className="text-xs text-muted hover:text-fg" title="Close">
          ✕
        </button>
      }
    >
      {(workload!.active_alerts.length > 0 || workload!.findings.length > 0) && (
        <DiagnosisSection workload={workload!} hostId={pickHostFromWorkload(workload!)} />
      )}
      <h4 className="mt-3 text-[10px] font-semibold uppercase tracking-wider text-muted">Pods</h4>
      <ul className="mt-1 space-y-2 text-sm">
        {workload!.pods.map(pod => <PodRow key={pod.pod_uid} pod={pod} navigate={navigate} />)}
      </ul>
    </Card>
  );
}

function pickHostFromWorkload(wl: TopologyWorkload): string | null {
  return wl.pods[0]?.host_id ?? null;
}

const ALERT_TONE: Record<string, string> = {
  critical: 'border-danger/40 bg-danger/5 text-danger',
  error: 'border-warning/40 bg-warning/5 text-warning',
  warning: 'border-info/40 bg-info/5 text-info',
  info: 'border-border bg-bg-secondary/40 text-muted',
};

function DiagnosisSection({ workload, hostId }: { workload: TopologyWorkload; hostId: string | null }) {
  return (
    <div className="space-y-2">
      <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted">
        Diagnosis ({workload.active_alerts.length + workload.findings.length})
      </h4>
      {workload.active_alerts.length > 0 && (
        <div className="space-y-1.5">
          {workload.active_alerts.slice(0, 6).map(a => (
            <AlertRow key={`${a.type}/${a.container_name}`} alert={a} hostId={hostId} />
          ))}
          {workload.active_alerts.length > 6 && (
            <Link
              to={`/alerts?q=${encodeURIComponent(workload.name)}`}
              className="block text-[11px] text-info hover:underline"
            >
              +{workload.active_alerts.length - 6} more on the alerts page →
            </Link>
          )}
        </div>
      )}
      {workload.findings.length > 0 && (
        <div className="space-y-1.5">
          {workload.findings.slice(0, 4).map((f, i) => (
            <FindingRow key={`${f.container_name}-${i}`} finding={f} hostId={hostId} />
          ))}
        </div>
      )}
    </div>
  );
}

function AlertRow({ alert, hostId }: { alert: TopologyAlert; hostId: string | null }) {
  const tone = ALERT_TONE[alert.level] ?? ALERT_TONE.info;
  // The container detail page is the actionable destination — link to it
  // when we know which host owns the container. (Cluster-scoped alert types
  // like pod_pending have host_id=cluster_id, not a host — fall back to the
  // alerts page for those.)
  const canLink = !!hostId && !alert.type.startsWith('pod_pending');
  const containerHref = canLink
    ? `/hosts/${encodeURIComponent(hostId!)}/containers/${encodeURIComponent(alert.container_name)}`
    : `/alerts?q=${encodeURIComponent(alert.container_name)}`;
  return (
    <Link
      to={containerHref}
      className="block rounded border border-border bg-bg-secondary/40 p-1.5 text-xs hover:border-info/40 hover:bg-info/5"
    >
      <div className="flex items-center gap-2">
        <span className={`shrink-0 rounded border px-1 py-0.5 text-[9px] font-medium uppercase tracking-wider ${tone}`}>
          {alert.level}
        </span>
        <span className="truncate font-mono text-fg">{alert.type}</span>
        <span className="ml-auto truncate text-[10px] text-muted">{alert.container_name.split('/').pop()}</span>
      </div>
      {alert.message && (
        <div className="mt-0.5 line-clamp-2 break-words text-[11px] text-secondary">
          {alert.message}
        </div>
      )}
    </Link>
  );
}

function FindingRow({ finding, hostId }: { finding: TopologyFinding; hostId: string | null }) {
  const tone = ALERT_TONE[finding.severity] ?? ALERT_TONE.info;
  const href = hostId
    ? `/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(finding.container_name)}`
    : '#';
  return (
    <Link
      to={href}
      className="block rounded border border-border bg-bg-secondary/40 p-1.5 text-xs hover:border-info/40 hover:bg-info/5"
    >
      <div className="flex items-center gap-2">
        <span className={`shrink-0 rounded border px-1 py-0.5 text-[9px] font-medium uppercase tracking-wider ${tone}`}>
          {finding.severity}
        </span>
        <span className="truncate text-fg">{finding.title}</span>
      </div>
      {finding.suggested_action && (
        <div className="mt-0.5 text-[11px] text-secondary">
          → {finding.suggested_action}
        </div>
      )}
    </Link>
  );
}

function ServiceDetail({ service: s, topo, onClose }: {
  service: TopologyService;
  topo: NamespaceTopology;
  onClose: () => void;
}) {
  const matchedWorkloads = topo.workloads.filter(wl => s.workload_keys.includes(workloadKeyOf(wl)));
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">
            Service · {s.type}
          </span>
          <span className="font-mono">{s.name}</span>
        </span>
      }
      actions={
        <button onClick={onClose} className="text-xs text-muted hover:text-fg" title="Close">
          ✕
        </button>
      }
    >
      <ul className="space-y-1 text-sm">
        {s.cluster_ip && (
          <li><span className="text-muted">Cluster IP:</span> <span className="font-mono">{s.cluster_ip}</span></li>
        )}
        {s.external_name && (
          <li><span className="text-muted">External name:</span> <span className="font-mono">{s.external_name}</span></li>
        )}
        {s.ports.length > 0 && (
          <li>
            <span className="text-muted">Ports:</span>{' '}
            <span className="font-mono text-xs">
              {s.ports.map(p => `${p.protocol ?? 'TCP'} ${p.port}${p.target_port != null ? `→${p.target_port}` : ''}${p.node_port != null ? ` (nodePort ${p.node_port})` : ''}`).join(', ')}
            </span>
          </li>
        )}
      </ul>
      <h4 className="mt-3 text-[10px] font-semibold uppercase tracking-wider text-muted">Backed by</h4>
      {matchedWorkloads.length === 0 ? (
        <p className="mt-1 text-xs text-warning">
          {s.is_external
            ? 'No selector — endpoints must be configured manually or this is an ExternalName.'
            : 'Selector matches no running pod in this namespace.'}
        </p>
      ) : (
        <ul className="mt-1 space-y-1 text-sm">
          {matchedWorkloads.map(wl => (
            <li key={workloadKeyOf(wl)} className="flex items-center justify-between gap-2 rounded border border-border bg-bg-secondary/40 px-2 py-1">
              <span className="flex min-w-0 items-center gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">{wl.kind ?? 'Pod'}</span>
                <span className="truncate font-mono">{wl.name}</span>
              </span>
              <span className="text-[11px] text-muted">{wl.total_pods} pod{wl.total_pods === 1 ? '' : 's'}</span>
            </li>
          ))}
        </ul>
      )}
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
  const selectedService = useMemo(() => {
    if (!data || !selected) return null;
    return data.services.find(s => serviceKeyOf(s) === selected) ?? null;
  }, [data, selected]);

  if (isLoading) return <LoadingState />;
  if (!data) return <EmptyState message="No topology data" />;

  const isEmpty = data.workloads.length === 0 && data.ingresses.length === 0 && data.services.length === 0;

  return (
    <div className="animate-fade-in space-y-4">
      <div className="flex items-center justify-between gap-3">
        <BackLink
          to={`/clusters/${encodeURIComponent(data.cluster_id)}`}
          label={`Back to cluster ${data.cluster_id}`}
        />
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
            <SidePanel workload={selectedWorkload} service={selectedService} topo={data} onClose={() => setSelected(null)} />
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
