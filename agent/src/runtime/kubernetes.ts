import fs = require('fs');
import https = require('https');
import logger = require('../../../shared/utils/logger');
import type {
  ContainerRuntime, ContainerInfo, ContainerWithResources,
  LogEntry, LogOptions, ContainerAction, ActionResult, ImageUpdate,
  HostMetricsOverride,
} from './types';

const { safeCollect } = require('../../../shared/utils/errors') as {
  safeCollect: <T>(label: string, fn: () => Promise<T>) => Promise<T | null>;
};

// ---- Minimal K8s API type definitions (only the fields we use) ----

interface K8sMeta {
  name?: string;
  namespace?: string;
  uid?: string;
  labels?: Record<string, string>;
  creationTimestamp?: string;
  ownerReferences?: Array<{ kind: string; name: string }>;
}

interface K8sContainerState {
  running?: { startedAt?: string };
  waiting?: { reason?: string };
  terminated?: { reason?: string };
}

interface K8sContainerStatus {
  name: string;
  ready: boolean;
  restartCount: number;
  state?: K8sContainerState;
  image: string;
}

interface K8sPod {
  metadata?: K8sMeta;
  spec?: { nodeName?: string };
  status?: {
    phase?: string;
    containerStatuses?: K8sContainerStatus[];
  };
}

interface K8sNode {
  metadata?: K8sMeta;
  status?: {
    capacity?: Record<string, string>;
    allocatable?: Record<string, string>;
    conditions?: Array<{ type: string; status: string }>;
  };
}

interface K8sReplicaSet {
  metadata?: K8sMeta;
}

interface K8sList<T> { items: T[] }

// ---- Lightweight K8s API client using raw HTTPS ----

class K8sClient {
  private apiServer: string;
  private token: string;
  private caCert: Buffer | null;

  constructor(apiServer: string, token: string, caCert: Buffer | null) {
    this.apiServer = apiServer;
    this.token = token;
    this.caCert = caCert;
  }

  /** GET a JSON resource from the K8s API server. */
  async get<T>(path: string): Promise<T> {
    const url = new URL(path, this.apiServer);
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'GET',
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
        ca: this.caCert ?? undefined,
        rejectUnauthorized: !!this.caCert,
      }, (res) => {
        let body = '';
        res.on('data', (chunk: string) => body += chunk);
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`K8s API ${path} returned ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          try { resolve(JSON.parse(body) as T); }
          catch (err) { reject(err as Error); }
        });
      });
      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('K8s API timeout')); });
      req.end();
    });
  }

  /** GET a text resource (used for pod logs). */
  async getText(path: string): Promise<string> {
    const url = new URL(path, this.apiServer);
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'GET',
        headers: { Authorization: `Bearer ${this.token}` },
        ca: this.caCert ?? undefined,
        rejectUnauthorized: !!this.caCert,
      }, (res) => {
        let body = '';
        res.on('data', (chunk: string) => body += chunk);
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`K8s API ${path} returned ${res.statusCode}`));
            return;
          }
          resolve(body);
        });
      });
      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('K8s API timeout')); });
      req.end();
    });
  }

  // ---- Typed convenience methods matching the old SDK surface ----

  async readNode(name: string): Promise<K8sNode> {
    return this.get<K8sNode>(`/api/v1/nodes/${encodeURIComponent(name)}`);
  }

  async listPods(fieldSelector?: string): Promise<K8sList<K8sPod>> {
    const qs = fieldSelector ? `?fieldSelector=${encodeURIComponent(fieldSelector)}` : '';
    return this.get<K8sList<K8sPod>>(`/api/v1/pods${qs}`);
  }

  async readReplicaSet(namespace: string, name: string): Promise<K8sReplicaSet> {
    return this.get<K8sReplicaSet>(
      `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/replicasets/${encodeURIComponent(name)}`,
    );
  }

  async readPodLog(namespace: string, podName: string, container: string, tailLines: number): Promise<string> {
    const qs = `?container=${encodeURIComponent(container)}&tailLines=${tailLines}&timestamps=true`;
    return this.getText(
      `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(podName)}/log${qs}`,
    );
  }
}

interface KubernetesRuntimeOptions {
  /** The node this agent runs on. Required — agent only reports containers on this node. */
  nodeName: string;
  /** Optional override for the kubelet URL. Defaults to https://${NODE_IP}:10250. */
  kubeletUrl?: string;
  /** Optional override for the node IP (used to construct kubelet URL). */
  nodeIp?: string;
}

/**
 * Kubernetes implementation of ContainerRuntime.
 *
 * Uses direct HTTPS calls to the K8s API server (no @kubernetes/client-node
 * dependency — saves ~90 MB of runtime memory from gRPC/protobufjs/etc).
 *
 * - Lists pods scoped to the node the agent runs on (via fieldSelector).
 * - Treats each container inside each pod as an insightd "container".
 * - Naming: `{namespace}/{pod-name}/{container-name}`.
 * - Metrics: queries the node-local kubelet at /metrics/cadvisor (Prometheus format).
 * - Logs: via the K8s API log endpoint.
 * - Actions: NOT supported (read-only monitoring mode).
 * - Update checks: NOT supported (k8s control plane manages image updates).
 */
export class KubernetesRuntime implements ContainerRuntime {
  readonly name = 'kubernetes' as const;
  readonly supportsActions = false;
  readonly supportsUpdateChecks = false;

  // Public for test stubbing (tests inject these directly)
  coreApi: K8sClient | null = null;
  private appsApi: K8sClient | null = null;  // Same client, separate field for clarity
  private nodeName: string;
  private kubeletUrl: string;
  private kubeletToken: string | null = null;
  private caCert: Buffer | null = null;

  // Previous cadvisor CPU counters for delta calculation
  private prevCpuUsage = new Map<string, { value: number; ts: number }>();

  constructor(options: KubernetesRuntimeOptions) {
    this.nodeName = options.nodeName;
    if (options.kubeletUrl) {
      this.kubeletUrl = options.kubeletUrl;
    } else if (options.nodeIp) {
      this.kubeletUrl = `https://${options.nodeIp}:10250`;
    } else {
      this.kubeletUrl = 'https://127.0.0.1:10250';
    }
  }

  async init(): Promise<void> {
    // Read service account credentials for API server auth
    let token: string;
    try {
      this.caCert = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt');
    } catch { /* CA not available — will use insecure TLS */ }
    try {
      token = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8').trim();
      this.kubeletToken = token;
    } catch {
      throw new Error('Cannot read service account token at /var/run/secrets/kubernetes.io/serviceaccount/token');
    }

    // Discover API server from cluster env vars
    const host = process.env.KUBERNETES_SERVICE_HOST;
    const port = process.env.KUBERNETES_SERVICE_PORT || '443';
    if (!host) {
      throw new Error('KUBERNETES_SERVICE_HOST not set — KubernetesRuntime requires in-cluster config');
    }
    // IPv6 addresses need brackets in URLs
    const hostPart = host.includes(':') ? `[${host}]` : host;
    const apiServer = `https://${hostPart}:${port}`;

    const client = new K8sClient(apiServer, token, this.caCert);
    this.coreApi = client;
    this.appsApi = client;

    logger.info('k8s', `Using API server ${apiServer} (in-cluster)`);

    // Verify we can reach the API and find our node
    try {
      const node = await client.readNode(this.nodeName);
      const conditions = node.status?.conditions?.filter(c => c.type === 'Ready') || [];
      logger.info('k8s', `Connected to cluster — node ${this.nodeName} is ${conditions[0]?.status === 'True' ? 'Ready' : 'NotReady'}`);
    } catch (err) {
      throw new Error(`Cannot find node "${this.nodeName}" in cluster: ${(err as Error).message}`);
    }
  }

  async listContainers(): Promise<ContainerInfo[]> {
    if (!this.coreApi) throw new Error('KubernetesRuntime not initialized');

    // List all pods on this node
    const res = await this.coreApi.listPods(`spec.nodeName=${this.nodeName}`);

    const containers: ContainerInfo[] = [];
    // Cache ReplicaSet → Deployment lookups for this collection cycle
    const rsCache = new Map<string, string>();

    for (const pod of res.items) {
      // Skip completed pods (Succeeded phase) — typically Helm install Jobs and similar
      // one-shot work that has nothing left to monitor.
      if (pod.status?.phase === 'Succeeded') continue;

      const namespace = pod.metadata?.namespace || 'default';
      const podUid = pod.metadata?.uid || '';
      const podLabels = pod.metadata?.labels || {};

      // Resolve a stable name from owner references so pod recreations don't
      // create new entries. Falls back to pod name for standalone pods.
      const stableName = await this.resolveStableName(pod, rsCache);

      // Each container in the pod becomes an insightd container
      const containerStatuses = pod.status?.containerStatuses || [];

      for (const cs of containerStatuses) {
        const name = `${namespace}/${stableName}/${cs.name}`;
        // Composite id: podUid + stableName + container so fetchLogs can fall
        // back to a name lookup if the UID is stale.
        const id = `${podUid}/${stableName}/${cs.name}`;

        // Status mapping: K8s container state → insightd status string
        let status = 'unknown';
        if (cs.state?.running) status = 'running';
        else if (cs.state?.waiting) status = cs.state.waiting.reason === 'Completed' ? 'exited' : 'created';
        else if (cs.state?.terminated) status = 'exited';

        // Health: derive from ready flag + pod conditions
        let healthStatus: string | null = null;
        if (cs.ready) {
          healthStatus = 'healthy';
        } else if (cs.state?.running && !cs.ready) {
          healthStatus = 'unhealthy';
        } else if (cs.state?.waiting) {
          healthStatus = 'starting';
        }

        containers.push({
          name,
          id,
          status,
          restartCount: cs.restartCount || 0,
          healthStatus,
          labels: { ...podLabels }, // container-level labels don't exist in K8s
          image: cs.image,
        });
      }
    }

    logger.info('containers', `Collected ${containers.length} containers on node ${this.nodeName}`);
    return containers;
  }

  /**
   * Resolve a stable identity for a pod by walking ownerReferences.
   *
   * - StatefulSet: pod name is already stable (web-0, web-1) → use pod name
   * - DaemonSet/Job: use the controller's name
   * - ReplicaSet: walk one more level to find the Deployment (cached per cycle)
   * - No owner: use pod name (standalone pod)
   *
   * This makes consecutive pods of the same logical app share the same insightd entry.
   */
  private async resolveStableName(pod: K8sPod, rsCache: Map<string, string>): Promise<string> {
    const ns = pod.metadata?.namespace ?? 'default';
    const podName = pod.metadata?.name ?? 'unknown';
    const owner = pod.metadata?.ownerReferences?.[0];
    if (!owner) return podName;

    switch (owner.kind) {
      case 'StatefulSet':
        // StatefulSet pods have deterministic names — keep the pod name
        return podName;
      case 'DaemonSet':
      case 'Job':
        return owner.name;
      case 'ReplicaSet': {
        // Walk up to the Deployment if there is one
        const cacheKey = `${ns}/${owner.name}`;
        const cached = rsCache.get(cacheKey);
        if (cached !== undefined) return cached;
        try {
          const rs = await this.appsApi!.readReplicaSet(ns, owner.name);
          const rsOwner = rs.metadata?.ownerReferences?.[0];
          const stable = rsOwner?.kind === 'Deployment' ? rsOwner.name : owner.name;
          rsCache.set(cacheKey, stable);
          return stable;
        } catch {
          rsCache.set(cacheKey, owner.name);
          return owner.name;
        }
      }
      default:
        return owner.name;
    }
  }

  async collectResources(containers: ContainerInfo[]): Promise<ContainerWithResources[]> {
    const result = containers as ContainerWithResources[];

    // Fetch cAdvisor metrics from the local kubelet
    const metrics = await safeCollect('kubelet-metrics', () => this.fetchKubeletMetrics());
    if (!metrics) {
      logger.warn('k8s', 'Failed to fetch kubelet metrics — resources will be null');
      return result;
    }

    const parsed = parseCadvisorMetrics(metrics);

    for (const c of result) {
      if (c.status !== 'running') continue;

      // Parse the composite id: `${podUid}/${stableName}/${containerName}`
      const parts = c.id.split('/');
      const podUid = parts[0];
      const containerName = parts[parts.length - 1];
      if (!podUid || !containerName) continue;

      const key = `${podUid}:${containerName}`;
      const m = parsed.get(key);
      if (!m) continue;

      // CPU: cAdvisor reports cumulative nanoseconds. Compute rate.
      const now = Date.now();
      const prev = this.prevCpuUsage.get(c.id);
      if (prev && m.cpuUsageSeconds != null) {
        const deltaSec = (now - prev.ts) / 1000;
        if (deltaSec > 0) {
          const cpuDelta = m.cpuUsageSeconds - prev.value;
          c.cpuPercent = cpuDelta > 0 ? Math.round((cpuDelta / deltaSec) * 100 * 100) / 100 : 0;
        }
      }
      if (m.cpuUsageSeconds != null) {
        this.prevCpuUsage.set(c.id, { value: m.cpuUsageSeconds, ts: now });
      }

      if (m.memoryUsageBytes != null) {
        c.memoryMb = Math.round(m.memoryUsageBytes / 1024 / 1024 * 100) / 100;
      }
      if (m.networkRxBytes != null) c.networkRxBytes = m.networkRxBytes;
      if (m.networkTxBytes != null) c.networkTxBytes = m.networkTxBytes;
      if (m.fsReadBytes != null) c.blkioReadBytes = m.fsReadBytes;
      if (m.fsWriteBytes != null) c.blkioWriteBytes = m.fsWriteBytes;

      logger.info('resources', `${c.name}: CPU=${c.cpuPercent ?? 'pending'}%, RAM=${c.memoryMb ?? '?'}MB`);
    }

    // Clean up stale entries
    const currentIds = new Set(result.map(c => c.id));
    for (const id of this.prevCpuUsage.keys()) {
      if (!currentIds.has(id)) this.prevCpuUsage.delete(id);
    }

    return result;
  }

  async fetchLogs(containerId: string, options: LogOptions): Promise<LogEntry[]> {
    if (!this.coreApi) throw new Error('KubernetesRuntime not initialized');

    // Parse the composite id: `${podUid}/${stableName}/${containerName}`
    // Older snapshots may use the legacy 2-segment form `${podUid}/${containerName}`
    // — we still handle that for backwards compatibility.
    const parts = containerId.split('/');
    if (parts.length < 2) throw new Error(`Invalid container ID: ${containerId}`);
    const podUid = parts[0];
    const containerName = parts[parts.length - 1];
    const stableName = parts.length >= 3 ? parts.slice(1, -1).join('/') : null;

    // Fetch all pods on this node once
    const pods = await this.coreApi.listPods(`spec.nodeName=${this.nodeName}`);

    // Try the recorded UID first — if the pod still exists, use it
    let pod = pods.items.find(p => p.metadata?.uid === podUid);

    // Fallback: pod was recreated since the snapshot. Find a current pod whose
    // stable owner identity matches what we recorded.
    if (!pod && stableName) {
      const rsCache = new Map<string, string>();
      for (const candidate of pods.items) {
        if (candidate.status?.phase === 'Succeeded') continue;
        const stable = await this.resolveStableName(candidate, rsCache);
        if (stable === stableName) {
          // Prefer running pods over others
          if (candidate.status?.phase === 'Running') {
            pod = candidate;
            break;
          }
          if (!pod) pod = candidate;
        }
      }
    }

    if (!pod) {
      throw new Error(`Pod for container "${containerId}" not found on this node`);
    }

    const namespace = pod.metadata?.namespace || 'default';
    const podName = pod.metadata?.name || '';

    const tailLines = Math.min(Math.max(options.lines || 100, 1), 1000);
    const text = await this.coreApi.readPodLog(namespace, podName, containerName, tailLines);

    // K8s returns plain text — parse into LogEntry[]
    return text.split('\n').filter(l => l.length > 0).map(line => {
      const { timestamp, message } = splitKubeTimestamp(line);
      return { stream: 'stdout' as const, timestamp, message };
    });
  }

  async performAction(_containerName: string, _action: ContainerAction): Promise<ActionResult> {
    throw new Error('Container actions are not supported in Kubernetes mode (read-only monitoring)');
  }

  async checkImageUpdates(): Promise<ImageUpdate[]> {
    // Not supported — k8s manages image updates via deployments/rollouts
    return [];
  }

  /**
   * Override host metrics with the kubelet's view of the node.
   *
   * /proc/* and /sys/* inside a containerized agent (e.g. k3d, where each
   * "node" is a Docker container running k3s) reflect the underlying
   * machine's kernel — they have no idea they're in a container. CPU%,
   * memory totals, load average, temperature, and uptime are all the
   * underlying VM's, not the node's.
   *
   * Kubelet exposes per-node stats at `/stats/summary` (used here) and the
   * Node API has the static capacity info. We combine both to override the
   * /proc values where we have a meaningful replacement, and explicitly
   * NULL out fields we genuinely cannot observe in k8s mode (load average,
   * which is a kernel concept that doesn't map to a single node anyway).
   *
   * Returns null on any failure — the scheduler then keeps the /proc values.
   */
  async getHostMetrics(): Promise<HostMetricsOverride | null> {
    if (!this.coreApi) return null;
    try {
      const [stats, node] = await Promise.all([
        this.fetchKubeletStats().catch(() => null),
        this.coreApi.readNode(this.nodeName).catch(() => null),
      ]);
      if (!stats && !node) return null;

      const ns = (stats?.node || {}) as Record<string, any>;
      const cpu = (ns.cpu || {}) as { usageNanoCores?: number };
      const mem = (ns.memory || {}) as { workingSetBytes?: number; availableBytes?: number };

      // CPU% — kubelet exposes a snapshot rate in nanoCores. Divide by core
      // count to get the per-core percentage (0–100 across the whole node).
      let cpuPercent: number | null | undefined = undefined;
      const cpuCount = parseInt(node?.status?.capacity?.cpu || '0', 10);
      if (cpu.usageNanoCores != null && cpuCount > 0) {
        cpuPercent = Math.round((cpu.usageNanoCores / 1e9 / cpuCount) * 100 * 100) / 100;
      }

      const memoryUsedMb = mem.workingSetBytes != null
        ? Math.round((mem.workingSetBytes / 1024 / 1024) * 100) / 100
        : undefined;
      const memoryAvailableMb = mem.availableBytes != null
        ? Math.round((mem.availableBytes / 1024 / 1024) * 100) / 100
        : undefined;

      // Total memory: prefer Node.status.allocatable (what workloads can use),
      // fall back to capacity (physical/configured limit). Both are k8s
      // quantity strings like "16384Mi" that need parsing.
      const allocBytes = parseQuantity(node?.status?.allocatable?.memory);
      const capBytes = parseQuantity(node?.status?.capacity?.memory);
      const totalBytes = allocBytes ?? capBytes;
      const memoryTotalMb = totalBytes != null
        ? Math.round((totalBytes / 1024 / 1024) * 100) / 100
        : undefined;

      // Uptime: use Node.metadata.creationTimestamp (when the node
      // registered with the cluster). Kubelet's `stats.node.startTime`
      // looks promising but actually returns the *kernel boot time* of
      // the underlying machine — same trap as /proc/uptime, since the
      // kubelet running inside a k3d container reads the host kernel.
      let uptimeSeconds: number | null | undefined = undefined;
      const startSource = node?.metadata?.creationTimestamp;
      if (startSource) {
        const ms = new Date(startSource).getTime();
        if (Number.isFinite(ms)) {
          const sec = Math.floor((Date.now() - ms) / 1000);
          if (sec >= 0) uptimeSeconds = sec;
        }
      }

      return {
        cpuPercent,
        memoryUsedMb,
        memoryAvailableMb,
        memoryTotalMb,
        // K8s nodes have no meaningful per-node load average (it's a kernel
        // concept that's shared across all containers on the host). Suppress
        // the bogus /proc value rather than report something misleading.
        load1: null,
        load5: null,
        load15: null,
        uptimeSeconds,
      };
    } catch {
      return null;
    }
  }

  /**
   * Fetch the kubelet's `/stats/summary` JSON. This is the per-node view
   * the kubelet maintains for its own scheduling decisions — much more
   * accurate than scraping cAdvisor for node-level totals.
   */
  fetchKubeletStats(): Promise<any> {
    return new Promise((resolve, reject) => {
      const url = new URL('/stats/summary', this.kubeletUrl);
      const req = https.request({
        hostname: url.hostname,
        port: url.port || 10250,
        path: url.pathname,
        method: 'GET',
        headers: this.kubeletToken ? { Authorization: `Bearer ${this.kubeletToken}` } : {},
        ca: this.caCert ?? undefined,
        rejectUnauthorized: false,
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Kubelet /stats/summary returned ${res.statusCode}`));
            return;
          }
          try { resolve(JSON.parse(body)); }
          catch (err) { reject(err as Error); }
        });
      });
      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('Kubelet timeout')); });
      req.end();
    });
  }

  /**
   * Fetch raw Prometheus metrics from the local kubelet's cAdvisor endpoint.
   * Uses the service account token for authentication.
   */
  private fetchKubeletMetrics(): Promise<string> {
    return new Promise((resolve, reject) => {
      const url = new URL('/metrics/cadvisor', this.kubeletUrl);
      const req = https.request({
        hostname: url.hostname,
        port: url.port || 10250,
        path: url.pathname,
        method: 'GET',
        headers: this.kubeletToken ? { Authorization: `Bearer ${this.kubeletToken}` } : {},
        ca: this.caCert ?? undefined,
        // Kubelet serving cert is typically self-signed; allow without CA verification
        rejectUnauthorized: false,
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Kubelet returned ${res.statusCode}`));
            return;
          }
          resolve(body);
        });
      });
      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('Kubelet timeout')); });
      req.end();
    });
  }
}

// --- cAdvisor metrics parsing ---

interface ContainerMetrics {
  cpuUsageSeconds?: number;  // cumulative
  memoryUsageBytes?: number; // current
  networkRxBytes?: number;   // cumulative (pod-level)
  networkTxBytes?: number;   // cumulative (pod-level)
  fsReadBytes?: number;      // cumulative
  fsWriteBytes?: number;     // cumulative
}

/**
 * Parse Prometheus-format cAdvisor metrics into per-container data.
 * Keyed by `${pod_uid}:${container_name}`.
 *
 * Relevant metrics:
 * - container_cpu_usage_seconds_total{pod="...",namespace="...",container="...",id="/kubepods/..."}
 * - container_memory_working_set_bytes{...}
 * - container_network_receive_bytes_total{pod="...",namespace="..."} (pod-level, no container)
 * - container_network_transmit_bytes_total{...}
 * - container_fs_reads_bytes_total{...}
 * - container_fs_writes_bytes_total{...}
 */
export function parseCadvisorMetrics(raw: string): Map<string, ContainerMetrics> {
  const byKey = new Map<string, ContainerMetrics>();
  const lines = raw.split('\n');

  for (const line of lines) {
    if (line.startsWith('#') || line.length === 0) continue;

    // Match: metric_name{labels} value [timestamp]
    const match = line.match(/^(\w+)\{([^}]+)\}\s+([\d.e+-]+)/);
    if (!match) continue;

    const [, metric, labelsStr, valueStr] = match;
    const value = parseFloat(valueStr);
    if (!Number.isFinite(value)) continue;

    const labels = parseLabels(labelsStr);
    const pod = labels['pod'];
    const container = labels['container'];

    // Skip whole-pod metrics (no container label) for per-container metrics
    if (!pod) continue;

    // Get pod UID — cAdvisor exposes it via pod_uid label in newer versions,
    // or we can derive from the cgroup id. For now, use pod name + namespace as fallback.
    const podUid = labels['pod_uid'] || labels['id']?.match(/pod([a-f0-9-]+)/)?.[1] || pod;

    // Container-level metrics require a container label (not empty, not "POD")
    if (metric.startsWith('container_') && metric !== 'container_network_receive_bytes_total'
        && metric !== 'container_network_transmit_bytes_total') {
      if (!container || container === 'POD' || container === '') continue;
      const key = `${podUid}:${container}`;
      const m = byKey.get(key) || {};

      switch (metric) {
        case 'container_cpu_usage_seconds_total':
          m.cpuUsageSeconds = (m.cpuUsageSeconds || 0) + value;
          break;
        case 'container_memory_working_set_bytes':
          m.memoryUsageBytes = value;
          break;
        case 'container_fs_reads_bytes_total':
          m.fsReadBytes = (m.fsReadBytes || 0) + value;
          break;
        case 'container_fs_writes_bytes_total':
          m.fsWriteBytes = (m.fsWriteBytes || 0) + value;
          break;
      }
      byKey.set(key, m);
    }

    // Network metrics are pod-level — distribute to all containers in the pod
    if (metric === 'container_network_receive_bytes_total' || metric === 'container_network_transmit_bytes_total') {
      // We'll handle these in a second pass since we don't yet know which containers exist
      const key = `${podUid}:__pod__`;
      const m = byKey.get(key) || {};
      if (metric === 'container_network_receive_bytes_total') m.networkRxBytes = value;
      else m.networkTxBytes = value;
      byKey.set(key, m);
    }
  }

  // Distribute pod-level network metrics to each container in the pod
  const podKeys = [...byKey.keys()].filter(k => k.endsWith(':__pod__'));
  for (const podKey of podKeys) {
    const podMetrics = byKey.get(podKey)!;
    const uid = podKey.replace(':__pod__', '');
    for (const [k, v] of byKey.entries()) {
      if (k.startsWith(uid + ':') && !k.endsWith(':__pod__')) {
        if (podMetrics.networkRxBytes != null) v.networkRxBytes = podMetrics.networkRxBytes;
        if (podMetrics.networkTxBytes != null) v.networkTxBytes = podMetrics.networkTxBytes;
      }
    }
    byKey.delete(podKey);
  }

  return byKey;
}

function parseLabels(labelsStr: string): Record<string, string> {
  const out: Record<string, string> = {};
  // labels format: key="value",key2="value2",...
  const regex = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(labelsStr)) !== null) {
    out[m[1]] = m[2];
  }
  return out;
}

/**
 * Parse a Kubernetes resource quantity string into bytes (for memory) or
 * a plain number (for cpu/count). Supports decimal SI suffixes (k, M, G, T, P)
 * and binary IEC suffixes (Ki, Mi, Gi, Ti, Pi). Returns null on parse failure.
 *
 * Examples: "16384Mi" → 17179869184, "16Gi" → 17179869184, "100m" is NOT
 * supported here (it's milli-units, only meaningful for CPU which we read
 * from `capacity.cpu` as an integer count).
 */
export function parseQuantity(q: string | undefined | null): number | null {
  if (!q) return null;
  const match = String(q).match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]*)$/);
  if (!match) return null;
  const num = parseFloat(match[1]);
  if (!Number.isFinite(num)) return null;
  const suffix = match[2];
  const multipliers: Record<string, number> = {
    '':   1,
    'k':  1e3,
    'M':  1e6,
    'G':  1e9,
    'T':  1e12,
    'P':  1e15,
    'Ki': 1024,
    'Mi': 1024 ** 2,
    'Gi': 1024 ** 3,
    'Ti': 1024 ** 4,
    'Pi': 1024 ** 5,
  };
  const mult = multipliers[suffix];
  return mult != null ? num * mult : null;
}

function splitKubeTimestamp(line: string): { timestamp: string | null; message: string } {
  // K8s timestamps format: "2026-03-30T12:00:00.123456789Z message..."
  const match = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s(.*)$/);
  if (match) {
    return { timestamp: match[1], message: match[2] };
  }
  return { timestamp: null, message: line };
}
