import { parseQuantity } from '../runtime/kubernetes';
import type { K8sClient, K8sPv, K8sPvc, K8sEvent, K8sIngress, K8sPod, K8sService } from '../runtime/kubernetes';

export interface PvInfo {
  name: string;
  phase: string;
  capacityBytes: number | null;
  accessModes: string[];
  reclaimPolicy: string | null;
  storageClass: string | null;
  volumeMode: string | null;
  claimRef: { namespace: string; name: string } | null;
  csiDriver: string | null;
  createdAt: string | null;
  labels: Record<string, string>;
}

export interface PvcInfo {
  namespace: string;
  name: string;
  phase: string;
  storageClass: string | null;
  requestBytes: number | null;
  capacityBytes: number | null;
  accessModes: string[];
  volumeName: string | null;
  volumeMode: string | null;
  createdAt: string | null;
  labels: Record<string, string>;
}

export function mapPv(pv: K8sPv): PvInfo | null {
  const name = pv.metadata?.name;
  if (!name) return null;
  const claim = pv.spec?.claimRef;
  return {
    name,
    phase: pv.status?.phase ?? 'Unknown',
    capacityBytes: parseQuantity(pv.spec?.capacity?.storage),
    accessModes: pv.spec?.accessModes ?? [],
    reclaimPolicy: pv.spec?.persistentVolumeReclaimPolicy ?? null,
    storageClass: pv.spec?.storageClassName ?? null,
    volumeMode: pv.spec?.volumeMode ?? null,
    claimRef: claim?.namespace && claim?.name ? { namespace: claim.namespace, name: claim.name } : null,
    csiDriver: pv.spec?.csi?.driver ?? null,
    createdAt: pv.metadata?.creationTimestamp ?? null,
    labels: pv.metadata?.labels ?? {},
  };
}

export function mapPvc(pvc: K8sPvc): PvcInfo | null {
  const name = pvc.metadata?.name;
  const namespace = pvc.metadata?.namespace;
  if (!name || !namespace) return null;
  return {
    namespace,
    name,
    phase: pvc.status?.phase ?? 'Unknown',
    storageClass: pvc.spec?.storageClassName ?? null,
    requestBytes: parseQuantity(pvc.spec?.resources?.requests?.storage),
    capacityBytes: parseQuantity(pvc.status?.capacity?.storage),
    accessModes: pvc.spec?.accessModes ?? [],
    volumeName: pvc.spec?.volumeName ?? null,
    volumeMode: pvc.spec?.volumeMode ?? null,
    createdAt: pvc.metadata?.creationTimestamp ?? null,
    labels: pvc.metadata?.labels ?? {},
  };
}

export async function collectPvs(client: K8sClient): Promise<PvInfo[]> {
  const list = await client.listPvs();
  return (list.items || []).map(mapPv).filter((x): x is PvInfo => x !== null);
}

export async function collectPvcs(client: K8sClient): Promise<PvcInfo[]> {
  const list = await client.listPvcs();
  return (list.items || []).map(mapPvc).filter((x): x is PvcInfo => x !== null);
}

export interface EventInfo {
  eventUid: string;
  namespace: string | null;
  involvedKind: string;
  involvedName: string;
  reason: string;
  message: string | null;
  type: string;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export function mapEvent(ev: K8sEvent): EventInfo | null {
  const uid = ev.metadata?.uid;
  const kind = ev.involvedObject?.kind;
  const name = ev.involvedObject?.name;
  const reason = ev.reason;
  const type = ev.type;
  if (!uid || !kind || !name || !reason || !type) return null;

  // Prefer lastTimestamp/firstTimestamp (legacy API); fall back to eventTime
  // (new events.k8s.io-style), and finally to creationTimestamp. We always
  // want a non-null timestamp so the hub can sort + prune correctly.
  const fallback = ev.metadata?.creationTimestamp ?? new Date().toISOString();
  const firstSeenAt = ev.firstTimestamp || ev.eventTime || fallback;
  const lastSeenAt = ev.lastTimestamp || ev.eventTime || firstSeenAt;

  return {
    eventUid: uid,
    namespace: ev.involvedObject?.namespace ?? null,
    involvedKind: kind,
    involvedName: name,
    reason,
    message: ev.message ?? null,
    type,
    count: ev.count ?? 1,
    firstSeenAt,
    lastSeenAt,
  };
}

/**
 * List cluster-wide Warning events. `Normal` events are hundreds per cluster
 * per hour (Pulled, Scheduled, Started) and carry no actionable signal, so
 * v1 scopes to `Warning` only. The hub dedupes by event_uid so polling at
 * 60s just bumps `count`/`last_seen_at` on re-fire.
 */
export async function collectEvents(client: K8sClient): Promise<EventInfo[]> {
  const list = await client.listEvents('Warning');
  return (list.items || []).map(mapEvent).filter((x): x is EventInfo => x !== null);
}

// ---- Ingresses ----

export interface IngressPath {
  host: string;
  path: string;
  pathType: string | null;
  serviceName: string | null;
  servicePort: number | string | null;
}

export interface IngressInfo {
  namespace: string;
  name: string;
  ingressClass: string | null;
  hosts: string[];
  paths: IngressPath[];
  tlsHosts: string[];
  externalIp: string | null;
  createdAt: string | null;
  labels: Record<string, string>;
}

/**
 * Map a k8s Ingress into our flattened shape. Returns null for ingresses
 * with no actionable rule (no rule has a `host`) — those can't be turned
 * into a URL without an external IP, so they're dropped at the source.
 */
export function mapIngress(ing: K8sIngress): IngressInfo | null {
  const namespace = ing.metadata?.namespace;
  const name = ing.metadata?.name;
  if (!namespace || !name) return null;

  const rules = ing.spec?.rules ?? [];
  const hosts: string[] = [];
  const paths: IngressPath[] = [];
  for (const rule of rules) {
    const host = rule.host;
    if (!host) continue;
    if (!hosts.includes(host)) hosts.push(host);
    const httpPaths = rule.http?.paths ?? [];
    if (httpPaths.length === 0) {
      paths.push({ host, path: '/', pathType: null, serviceName: null, servicePort: null });
      continue;
    }
    for (const p of httpPaths) {
      const svc = p.backend?.service;
      paths.push({
        host,
        path: p.path ?? '/',
        pathType: p.pathType ?? null,
        serviceName: svc?.name ?? null,
        servicePort: svc?.port?.number ?? svc?.port?.name ?? null,
      });
    }
  }
  if (hosts.length === 0) return null;

  const tlsHosts: string[] = [];
  for (const tls of ing.spec?.tls ?? []) {
    for (const h of tls.hosts ?? []) {
      if (!tlsHosts.includes(h)) tlsHosts.push(h);
    }
  }

  const lb = ing.status?.loadBalancer?.ingress?.[0];
  const externalIp = lb?.ip ?? lb?.hostname ?? null;

  return {
    namespace,
    name,
    ingressClass: ing.spec?.ingressClassName ?? null,
    hosts,
    paths,
    tlsHosts,
    externalIp,
    createdAt: ing.metadata?.creationTimestamp ?? null,
    labels: ing.metadata?.labels ?? {},
  };
}

export async function collectIngresses(client: K8sClient): Promise<IngressInfo[]> {
  const list = await client.listIngresses();
  return (list.items || []).map(mapIngress).filter((x): x is IngressInfo => x !== null);
}

// ---- Pending pods ----

export interface PendingPodInfo {
  namespace: string;
  podName: string;
  reason: string | null;
  message: string | null;
  podPhase: string;
  podCreatedAt: string | null;
  workloadKind: string | null;
  workloadName: string | null;
}

/**
 * Reduce a Pending pod's status to the most actionable {reason, message}.
 *
 * Priority (highest first):
 *   1. PodScheduled=False — scheduler refused to place the pod (Unschedulable
 *      with "0/N nodes available: ..." message). Most actionable.
 *   2. ContainersReady=False with a waiting reason on a containerStatus —
 *      ImagePullBackOff / ErrImagePull / CreateContainerConfigError /
 *      CreateContainerError. Pulled from the first non-transient waiting
 *      container so the user sees *why* the pod can't run.
 *   3. Initialized=False — typically waiting on initContainers or PVC bind.
 *   4. Fall through to phase reason ("ContainerCreating" pre-image-pull).
 */
export function summarizePendingPod(pod: K8sPod): { reason: string | null; message: string | null } {
  const conditions = pod.status?.conditions ?? [];

  const scheduled = conditions.find(c => c.type === 'PodScheduled');
  if (scheduled && scheduled.status === 'False') {
    return {
      reason: scheduled.reason ?? 'Unschedulable',
      message: scheduled.message ?? null,
    };
  }

  const containerStatuses = pod.status?.containerStatuses ?? [];
  for (const cs of containerStatuses) {
    const waiting = cs.state?.waiting;
    if (waiting?.reason && waiting.reason !== 'ContainerCreating' && waiting.reason !== 'PodInitializing') {
      return { reason: waiting.reason, message: waiting.message ?? null };
    }
  }

  const initialized = conditions.find(c => c.type === 'Initialized');
  if (initialized && initialized.status === 'False') {
    return {
      reason: initialized.reason ?? 'NotInitialized',
      message: initialized.message ?? null,
    };
  }

  // Pod is genuinely still coming up — surface the first waiting reason if any.
  for (const cs of containerStatuses) {
    const waiting = cs.state?.waiting;
    if (waiting?.reason) {
      return { reason: waiting.reason, message: waiting.message ?? null };
    }
  }

  return { reason: null, message: null };
}

/**
 * Resolve the workload (kind, name) that owns a pod. Walks one level via
 * ownerReferences. ReplicaSet is left as-is — the leader collector has no
 * RS→Deployment lookup cache here, and "ReplicaSet/foo-7d9f8" is a clear
 * enough pointer for the user to find the parent Deployment.
 */
export function podWorkload(pod: K8sPod): { kind: string | null; name: string | null } {
  const owner = pod.metadata?.ownerReferences?.[0];
  if (!owner) return { kind: null, name: null };
  return { kind: owner.kind, name: owner.name };
}

export function mapPendingPod(pod: K8sPod): PendingPodInfo | null {
  if (pod.status?.phase !== 'Pending') return null;
  const namespace = pod.metadata?.namespace;
  const podName = pod.metadata?.name;
  if (!namespace || !podName) return null;

  const { reason, message } = summarizePendingPod(pod);
  const { kind, name } = podWorkload(pod);
  return {
    namespace,
    podName,
    reason,
    message,
    podPhase: 'Pending',
    podCreatedAt: pod.metadata?.creationTimestamp ?? null,
    workloadKind: kind,
    workloadName: name,
  };
}

export async function collectPendingPods(client: K8sClient): Promise<PendingPodInfo[]> {
  // Cluster-wide list (no fieldSelector) so unscheduled pods (no nodeName) are
  // included — those are the ones the per-node collectors miss entirely.
  const list = await client.listPods();
  return (list.items || []).map(mapPendingPod).filter((x): x is PendingPodInfo => x !== null);
}

// ---- Services ---------------------------------------------------------------
//
// We capture enough to draw real Ingress→Service→Workload edges in the
// namespace topology view: the selector (which decides which pods back the
// Service) and the ports (what the Service exposes). External-only Services
// (type=ExternalName, or empty selector) are still captured — they're often
// misconfigured and the user wants to see them as leaf nodes.

export interface ServicePort {
  name: string | null;
  port: number;
  /** Container port the Service forwards to. K8s allows string (named) or
   *  number (numeric). We preserve the original shape for display. */
  targetPort: number | string | null;
  protocol: string | null;
  nodePort: number | null;
}

export interface ServiceInfo {
  namespace: string;
  name: string;
  /** ClusterIP / NodePort / LoadBalancer / ExternalName. We default missing
   *  values to "ClusterIP" — that's what kubectl shows for the omitted-type
   *  case. */
  type: string;
  /** "None" for Headless services. Null means truly unset (rare — almost
   *  always populated by the API server). */
  clusterIp: string | null;
  externalIps: string[];
  /** Only set when type === "ExternalName". */
  externalName: string | null;
  /** Empty object means "no selector — Endpoints managed manually" (a
   *  pattern used to point at external resources). Distinct from null which
   *  means the Service spec didn't include a selector field at all. The
   *  topology join treats both equivalently (no pod backends found). */
  selector: Record<string, string> | null;
  ports: ServicePort[];
  createdAt: string | null;
  labels: Record<string, string>;
}

export function mapService(svc: K8sService): ServiceInfo | null {
  const namespace = svc.metadata?.namespace;
  const name = svc.metadata?.name;
  if (!namespace || !name) return null;

  const type = svc.spec?.type ?? 'ClusterIP';
  const ports: ServicePort[] = (svc.spec?.ports ?? []).map(p => ({
    name: p.name ?? null,
    port: p.port,
    targetPort: p.targetPort ?? null,
    protocol: p.protocol ?? null,
    nodePort: p.nodePort ?? null,
  }));

  return {
    namespace,
    name,
    type,
    clusterIp: svc.spec?.clusterIP ?? null,
    externalIps: svc.spec?.externalIPs ?? [],
    externalName: svc.spec?.externalName ?? null,
    selector: svc.spec?.selector ?? null,
    ports,
    createdAt: svc.metadata?.creationTimestamp ?? null,
    labels: svc.metadata?.labels ?? {},
  };
}

export async function collectServices(client: K8sClient): Promise<ServiceInfo[]> {
  const list = await client.listServices();
  return (list.items || []).map(mapService).filter((x): x is ServiceInfo => x !== null);
}
