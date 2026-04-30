import { useMemo, useState } from 'react';
import { useParams, useNavigate, Link, useSearchParams } from 'react-router-dom';
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
  TopologyVolumeMount,
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
/** Vertical gap between accumulated workload cards. Match Y_STEP - base
 *  workload height so single-row workloads keep the same density they had
 *  before variable heights were introduced. */
const WORKLOAD_GAP = 16;

/** Approximate rendered height for a workload card. Used to lay out the
 *  Workload column with accumulating Y so cards with extra rows
 *  (ConfigMap/Secret chips, severity badge) don't overlap the next card.
 *
 *  Numbers are conservative — slightly taller than the real DOM measurement —
 *  since we have no way to measure DOM rects synchronously while building
 *  the React Flow graph state. */
function workloadCardHeight(wl: TopologyWorkload): number {
  let h = 90; // border + padding + kind label + name + status row
  const chipMounts = wl.volume_mounts.filter(v =>
    (v.type === 'configMap' || v.type === 'secret') && v.target_name,
  );
  if (chipMounts.length > 0) {
    // Chip rows wrap at ~3 chips per row given the min-w-[280px] card width.
    const rows = Math.ceil(chipMounts.length / 3);
    h += 8 + rows * 22; // mt-2 gap + chip row height
  }
  return h;
}

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

function pvcKeyOf(p: { name: string }): string {
  return `pvc:${p.name}`;
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
      <ConfigMapSecretChips mounts={wl.volume_mounts} />
    </button>
  );
}

/** Inline chips for ConfigMap / Secret references on the workload card.
 *  PVCs are first-class graph nodes (rendered separately) so they're
 *  filtered out here. Ambient types (emptyDir / projected / hostPath) are
 *  too noisy to surface as chips. */
function ConfigMapSecretChips({ mounts }: { mounts: TopologyVolumeMount[] }) {
  const cms = mounts.filter(m => m.type === 'configMap' && m.target_name);
  const secrets = mounts.filter(m => m.type === 'secret' && m.target_name);
  if (cms.length === 0 && secrets.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {cms.map(c => (
        <span
          key={`cm-${c.target_name}`}
          title={`ConfigMap: ${c.target_name}`}
          className="rounded border border-border bg-bg-secondary/40 px-1.5 py-0.5 font-mono text-[10px] text-secondary"
        >
          cm/{c.target_name}
        </span>
      ))}
      {secrets.map(s => (
        <span
          key={`sec-${s.target_name}`}
          title={`Secret: ${s.target_name}`}
          className="rounded border border-warning/40 bg-warning/5 px-1.5 py-0.5 font-mono text-[10px] text-warning"
        >
          sec/{s.target_name}
        </span>
      ))}
    </div>
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

function PvcCard({ data }: { data: { pvc: TopologyPvc } }) {
  const { pvc } = data;
  const phaseTone = pvc.phase === 'Bound'
    ? 'border-success/40 bg-success/5'
    : pvc.phase === 'Pending'
      ? 'border-warning/40 bg-warning/5'
      : 'border-border bg-bg-secondary/40';
  const sizeText = pvc.capacity_bytes != null
    ? formatGb(pvc.capacity_bytes)
    : null;
  return (
    <div className={`flex min-w-[220px] flex-col rounded-lg border p-3 shadow-sm ${phaseTone}`}>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">
        PVC · {pvc.phase}
      </div>
      <div className="mt-0.5 truncate font-mono text-sm font-bold text-fg" title={pvc.name}>
        {pvc.name}
      </div>
      {(sizeText || pvc.storage_class) && (
        <div className="mt-1 text-[11px] text-muted">
          {sizeText && <span>{sizeText}</span>}
          {sizeText && pvc.storage_class && <span> · </span>}
          {pvc.storage_class && <span>{pvc.storage_class}</span>}
        </div>
      )}
    </div>
  );
}

function formatGb(bytes: number): string {
  const gb = bytes / (1024 ** 3);
  if (gb < 1) return `${(bytes / (1024 ** 2)).toFixed(0)} Mi`;
  if (gb < 10) return `${gb.toFixed(1)} Gi`;
  return `${Math.round(gb)} Gi`;
}

const NODE_TYPES = {
  workload: WorkloadCard,
  ingress: IngressCard,
  k8sNode: NodeCard,
  service: ServiceCard,
  pvc: PvcCard,
};

// ── Build nodes + edges ─────────────────────────────────────────────────────

interface FilterState {
  /** Lowercase search query — empty string = no filter. */
  q: string;
  /** Hide orphan services (no backends) and PVCs (no workload mounts). */
  hideOrphans: boolean;
}

/** Compute which node ids should be visible / dimmed given the active filters
 *  and selection. A node is *visible* when it survives hide-orphans; it's
 *  *highlighted* when no filter is active OR it matches the search query OR
 *  it's the selected node OR it's a 1-hop neighbor of the selected node. */
function computeVisibility(
  topo: NamespaceTopology,
  filter: FilterState,
  selected: string | null,
): { hidden: Set<string>; dimmed: Set<string> } {
  const hidden = new Set<string>();
  const dimmed = new Set<string>();

  // Hide-orphans: services with no backends (and not ExternalName), PVCs that
  // no workload mounts, ingresses that don't resolve to any service in this
  // namespace. Workloads are kept even when they have 0 pods because that's
  // a valid topology state.
  if (filter.hideOrphans) {
    const pvcsWithMount = new Set<string>();
    for (const wl of topo.workloads) {
      for (const vm of wl.volume_mounts) {
        if (vm.type === 'pvc' && vm.target_name) pvcsWithMount.add(vm.target_name);
      }
    }
    for (const s of topo.services) {
      if (s.is_external) continue;
      if (s.workload_keys.length === 0) hidden.add(serviceKeyOf(s));
    }
    for (const p of topo.pvcs) {
      if (!pvcsWithMount.has(p.name)) hidden.add(pvcKeyOf(p));
    }
    const serviceNames = new Set(topo.services.map(s => s.name));
    for (const ing of topo.ingresses) {
      const anyHit = ing.service_targets.some(t => serviceNames.has(t));
      if (!anyHit) hidden.add(ingressKeyOf(ing));
    }
  }

  const allKeys = new Set<string>([
    ...topo.workloads.map(workloadKeyOf),
    ...topo.services.map(serviceKeyOf),
    ...topo.ingresses.map(ingressKeyOf),
    ...topo.pvcs.map(pvcKeyOf),
    ...topo.nodes.map(nodeKeyOf),
  ]);

  // Search match: any node whose displayed name (workload.name, service.name,
  // ingress.name, pvc.name, node.host_id) contains the lowercased query.
  const q = filter.q.trim().toLowerCase();
  const searchMatches = new Set<string>();
  if (q) {
    for (const w of topo.workloads) if (w.name.toLowerCase().includes(q)) searchMatches.add(workloadKeyOf(w));
    for (const s of topo.services) if (s.name.toLowerCase().includes(q)) searchMatches.add(serviceKeyOf(s));
    for (const i of topo.ingresses) if (i.name.toLowerCase().includes(q)) searchMatches.add(ingressKeyOf(i));
    for (const p of topo.pvcs) if (p.name.toLowerCase().includes(q)) searchMatches.add(pvcKeyOf(p));
    for (const n of topo.nodes) if (n.host_id.toLowerCase().includes(q)) searchMatches.add(nodeKeyOf(n));
  }

  // Selection focus: when a node is selected, dim everything not 1-hop
  // connected to it. We compute the connectivity from the same edge sources
  // the graph uses (Ingress→Service, Service→Workload, Workload→Node,
  // Workload→PVC, RCA edges).
  const focused = new Set<string>();
  if (selected) {
    focused.add(selected);
    for (const ing of topo.ingresses) {
      for (const target of ing.service_targets) {
        const svc = topo.services.find(s => s.name === target);
        if (!svc) continue;
        const ingKey = ingressKeyOf(ing);
        const svcKey = serviceKeyOf(svc);
        if (selected === ingKey) focused.add(svcKey);
        if (selected === svcKey) focused.add(ingKey);
      }
    }
    for (const s of topo.services) {
      const svcKey = serviceKeyOf(s);
      for (const wlKey of s.workload_keys) {
        if (selected === svcKey) focused.add(wlKey);
        if (selected === wlKey) focused.add(svcKey);
      }
    }
    for (const w of topo.workloads) {
      const wlKey = workloadKeyOf(w);
      for (const hostId of Object.keys(w.pods_by_node)) {
        const nKey = nodeKeyOf({ host_id: hostId });
        if (selected === wlKey) focused.add(nKey);
        if (selected === nKey) focused.add(wlKey);
      }
      for (const vm of w.volume_mounts) {
        if (vm.type !== 'pvc' || !vm.target_name) continue;
        const pvcKey = pvcKeyOf({ name: vm.target_name });
        if (selected === wlKey) focused.add(pvcKey);
        if (selected === pvcKey) focused.add(wlKey);
      }
    }
    for (const e of topo.rca_edges) {
      if (selected === e.from) focused.add(e.to);
      if (selected === e.to) focused.add(e.from);
    }
  }

  // A node is dimmed when filters are active and it doesn't match.
  const filterActive = q.length > 0 || selected !== null;
  if (filterActive) {
    for (const k of allKeys) {
      if (hidden.has(k)) continue;
      const matchesSearch = !q || searchMatches.has(k);
      const matchesFocus = !selected || focused.has(k);
      if (!matchesSearch || !matchesFocus) dimmed.add(k);
    }
  }
  return { hidden, dimmed };
}

function buildGraph(
  topo: NamespaceTopology,
  selected: string | null,
  setSelected: (k: string | null) => void,
  filter: FilterState = { q: '', hideOrphans: false },
): { nodes: Node[]; edges: Edge[] } {
  const { hidden, dimmed } = computeVisibility(topo, filter, selected);
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

  // Workload cards have variable height — header + name + status row are
  // fixed, but ConfigMap/Secret chips wrap and add a row when present.
  // Accumulate y-positions so taller cards don't overlap the next one.
  let workloadY = Y_TOP;
  const workloadEndY: Map<string, number> = new Map();
  topo.workloads.forEach((wl) => {
    const key = workloadKeyOf(wl);
    const height = workloadCardHeight(wl);
    nodes.push({
      id: key,
      type: 'workload',
      position: { x: COL_X.workload, y: workloadY },
      data: {
        workload: wl,
        onClick: () => setSelected(selected === key ? null : key),
        active: selected === key,
      },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    });
    workloadEndY.set(key, workloadY + height);
    workloadY += height + WORKLOAD_GAP;
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

  // PVCs — stacked below the Workload column with a small gap so the
  // vertical "mounted by" relationship reads naturally below the
  // Ingress→Service→Workload→Node horizontal flow. Anchor to the actual
  // end of the workload column (which has variable-height cards) rather
  // than to a fixed step count so PVCs don't overlap the last workload.
  const PVC_GAP = 60;
  const pvcsBaseY = workloadY === Y_TOP
    ? Y_TOP + PVC_GAP
    : workloadY - WORKLOAD_GAP + PVC_GAP;
  topo.pvcs.forEach((pvc, i) => {
    nodes.push({
      id: pvcKeyOf(pvc),
      type: 'pvc',
      position: { x: COL_X.workload, y: pvcsBaseY + i * Y_STEP },
      data: { pvc },
      targetPosition: Position.Top,
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

  // Workload → PVC edges. Only PVC volume mounts that resolve to a PVC node
  // we already render get an edge — orphan references (PVC not collected
  // yet) are silently dropped to avoid floating arrows. ConfigMap/Secret
  // mounts render as chips on the workload card, not as edges, since we
  // don't currently ingest them as inventory.
  const pvcNamesInGraph = new Set(topo.pvcs.map(p => p.name));
  for (const wl of topo.workloads) {
    const wlKey = workloadKeyOf(wl);
    for (const vm of wl.volume_mounts) {
      if (vm.type !== 'pvc' || !vm.target_name) continue;
      if (!pvcNamesInGraph.has(vm.target_name)) continue;
      edges.push({
        id: `e:${wlKey}->pvc-${vm.target_name}`,
        source: wlKey,
        target: pvcKeyOf({ name: vm.target_name }),
        style: { stroke: 'var(--color-info)', strokeWidth: 1.25 },
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

  // Apply hide-orphans + dim filter post-build. Hide drops the node entirely
  // and drops every edge that touches it; dim halves opacity on the node and
  // its edges so the focused subgraph reads cleanly while the rest stays in
  // sight as faint context.
  const finalNodes = nodes
    .filter(n => !hidden.has(n.id))
    .map(n => dimmed.has(n.id)
      ? { ...n, style: { ...(n.style ?? {}), opacity: 0.25 } }
      : n);
  const finalEdges = edges
    .filter(e => !hidden.has(e.source) && !hidden.has(e.target))
    .map(e => (dimmed.has(e.source) || dimmed.has(e.target))
      ? { ...e, style: { ...(e.style ?? {}), opacity: 0.25 } }
      : e);

  return { nodes: finalNodes, edges: finalEdges };
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
  const [searchParams, setSearchParams] = useSearchParams();

  // URL state — search, hide-orphans, time-travel.
  const q = searchParams.get('q') ?? '';
  const hideOrphans = searchParams.get('hide_orphans') === '1';
  const at = searchParams.get('at') || null;

  const updateParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (!value) next.delete(key);
    else next.set(key, value);
    setSearchParams(next, { replace: true });
  };

  // Refetch the topology when `at` changes — every URL state change creates
  // a different cache key, which is what we want.
  const { data, isLoading } = useQuery({
    queryKey: [...queryKeys.namespaceTopology(clusterId, namespace), at] as const,
    queryFn: () => {
      const path = `/clusters/${encodeURIComponent(clusterId!)}/namespaces/${encodeURIComponent(namespace!)}/topology`;
      const qs = at ? `?at=${encodeURIComponent(at)}` : '';
      return api<NamespaceTopology>(path + qs);
    },
    // Live mode polls; time-travel mode is a static snapshot.
    refetchInterval: at ? false : 30_000,
  });

  const graph = useMemo(() => {
    if (!data) return { nodes: [], edges: [] };
    return buildGraph(data, selected, setSelected, { q, hideOrphans });
  }, [data, selected, q, hideOrphans]);

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

      {data.at && <TimeTraveledBanner at={data.at} onBackToLive={() => updateParam('at', null)} />}

      {isEmpty ? (
        <EmptyState message="No workloads or ingresses observed in this namespace." />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
          <div className="space-y-3">
            <TopologyToolbar
              q={q}
              onSearch={(v) => updateParam('q', v || null)}
              hideOrphans={hideOrphans}
              onToggleHideOrphans={(v) => updateParam('hide_orphans', v ? '1' : null)}
              at={at}
              onSetAt={(v) => updateParam('at', v)}
            />
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

// ── Toolbar (search, hide-orphans, time scrubber) ───────────────────────────

interface TopologyToolbarProps {
  q: string;
  onSearch: (v: string) => void;
  hideOrphans: boolean;
  onToggleHideOrphans: (v: boolean) => void;
  /** ISO timestamp, null when live. */
  at: string | null;
  /** Setter — pass an ISO string to time-travel, null to return to live. */
  onSetAt: (v: string | null) => void;
}

function TopologyToolbar({ q, onSearch, hideOrphans, onToggleHideOrphans, at, onSetAt }: TopologyToolbarProps) {
  const minutesAgo = (m: number): string =>
    new Date(Date.now() - m * 60_000).toISOString();
  const isLive = at === null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs">
      <input
        type="text"
        placeholder="Filter nodes…"
        value={q}
        onChange={e => onSearch(e.target.value)}
        className="w-48 rounded border border-border bg-bg-secondary/40 px-2 py-1 text-xs placeholder:text-muted focus:border-info focus:outline-none"
        aria-label="Filter topology nodes by name"
      />
      <label className="flex cursor-pointer items-center gap-1.5">
        <input
          type="checkbox"
          checked={hideOrphans}
          onChange={e => onToggleHideOrphans(e.target.checked)}
          className="h-3.5 w-3.5 cursor-pointer accent-info"
        />
        <span className="text-secondary">Hide orphans</span>
      </label>

      <div className="ml-auto flex items-center gap-1.5 border-l border-border pl-3">
        <span className="text-[10px] uppercase tracking-wider text-muted">Time</span>
        <button
          type="button"
          onClick={() => onSetAt(null)}
          className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
            isLive
              ? 'border border-success/40 bg-success/10 text-success'
              : 'border border-border bg-bg-secondary/40 text-muted hover:text-fg'
          }`}
          title="Return to live data"
        >
          ● Live
        </button>
        {[
          { label: '1h', m: 60 },
          { label: '6h', m: 360 },
          { label: '24h', m: 1440 },
        ].map(({ label, m }) => (
          <button
            key={label}
            type="button"
            onClick={() => onSetAt(minutesAgo(m))}
            className="rounded border border-border bg-bg-secondary/40 px-2 py-0.5 text-[11px] text-muted hover:border-info/40 hover:text-fg"
            title={`View namespace as it was ${label} ago`}
          >
            -{label}
          </button>
        ))}
        <input
          type="datetime-local"
          // Bind the picker to the current `at` (if any), trimmed to local-input format.
          value={at ? new Date(at).toISOString().slice(0, 16) : ''}
          onChange={e => {
            const v = e.target.value;
            if (!v) { onSetAt(null); return; }
            const ms = Date.parse(v);
            if (Number.isFinite(ms)) onSetAt(new Date(ms).toISOString());
          }}
          className="rounded border border-border bg-bg-secondary/40 px-1.5 py-0.5 text-[11px] text-fg focus:border-info focus:outline-none"
          aria-label="Custom timestamp"
        />
      </div>
    </div>
  );
}

function TimeTraveledBanner({ at, onBackToLive }: { at: string; onBackToLive: () => void }) {
  const ago = relativeAgo(at);
  return (
    <div className="rounded-lg border border-info/40 bg-info/5 px-3 py-2 text-sm">
      <span className="font-semibold text-info">⏱ Viewing snapshot</span>
      <span className="ml-2 font-mono text-[11px] text-fg" title={at}>{at}</span>
      {ago && <span className="ml-1 text-[11px] text-muted">({ago})</span>}
      <span className="ml-3 text-[11px] text-muted">
        RCA neighbor edges and diagnosis findings are live-only — hidden in time-traveled mode.
      </span>
      <button
        type="button"
        onClick={onBackToLive}
        className="ml-3 rounded border border-info/40 bg-info/10 px-2 py-0.5 text-[11px] font-medium text-info hover:bg-info/20"
      >
        ← Back to live
      </button>
    </div>
  );
}

function relativeAgo(iso: string): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const sec = Math.round((Date.now() - ms) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}
