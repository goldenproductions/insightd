/**
 * Container runtime abstraction layer.
 *
 * Defines the interface that all container runtime implementations must
 * satisfy. Allows insightd to support Docker, containerd, and Kubernetes
 * from a single codebase.
 */

export type RuntimeName = 'docker' | 'containerd' | 'kubernetes';
export type ContainerAction = 'start' | 'stop' | 'restart' | 'remove';

export interface ContainerInfo {
  name: string;
  id: string;
  status: string;
  restartCount: number;
  healthStatus: string | null;
  /** Last Docker health check output (truncated). Null if no health check configured. */
  healthCheckOutput?: string | null;
  labels: Record<string, string>;
  /** Image reference — used for update checks. Optional. */
  image?: string;
  /**
   * Exit code for containers no longer running. Null for running containers
   * or when the runtime can't report it. Distinguishes "completed
   * successfully" (0) from "failed" (non-zero) for one-shot containers.
   */
  exitCode?: number | null;
  /**
   * Total rootfs size (image layers + writable) in bytes. Docker only —
   * Kubernetes doesn't expose an equivalent.
   */
  sizeRootfsBytes?: number | null;
  /**
   * Writable layer size in bytes (what the container has written on top of
   * its image). Docker only. For k8s we map cAdvisor's
   * container_fs_usage_bytes onto sizeRootfsBytes instead.
   */
  sizeRwBytes?: number | null;
}

export interface ContainerWithResources extends ContainerInfo {
  cpuPercent?: number | null;
  memoryMb?: number | null;
  networkRxBytes?: number | null;
  networkTxBytes?: number | null;
  blkioReadBytes?: number | null;
  blkioWriteBytes?: number | null;
}

export interface LogOptions {
  lines?: number;
  stream?: 'both' | 'stdout' | 'stderr';
}

export interface LogEntry {
  stream: 'stdout' | 'stderr';
  timestamp: string | null;
  message: string;
}

export interface ImageUpdate {
  containerName: string;
  image: string;
  localDigest: string | null;
  remoteDigest: string | null;
  hasUpdate: boolean;
}

export interface ActionResult {
  status: 'success' | 'failed';
  message: string;
}

export interface VolumeInfo {
  name: string;
  driver: string;
  mountpoint: string | null;
  /** Filesystem size in bytes. Null if the runtime can't report it. */
  sizeBytes: number | null;
  /** Number of containers currently mounting this volume. Null if unknown. */
  refCount: number | null;
  /** ISO timestamp from the runtime's own metadata. Null if unknown. */
  createdAt: string | null;
  labels: Record<string, string>;
}

/**
 * Runtime-specific override for host-level metrics. Used by containerized
 * runtimes (e.g. Kubernetes) where /proc/* and /sys/* reflect the underlying
 * machine's kernel — not the container or node the agent reports on.
 *
 * Each field is optional. The scheduler only overrides values where the
 * runtime returns a non-undefined replacement. Values explicitly set to
 * `null` mean "this runtime can't observe this metric meaningfully — emit
 * NULL rather than the bogus /proc value".
 */
/**
 * A single disk/filesystem usage entry. Shared between the on-host
 * `collectDisk` collector (Docker/standalone) and runtime-provided disk
 * metrics (Kubernetes — sourced from kubelet `/stats/summary` rather than
 * `/proc/mounts`, which is unreliable inside a containerized agent).
 */
export interface DiskResult {
  mountPoint: string;
  totalGb: number;
  usedGb: number;
  usedPercent: number;
}

export interface NodeCondition {
  type: string;
  status: 'True' | 'False' | 'Unknown';
  reason?: string | null;
  message?: string | null;
  lastHeartbeatTime?: string | null;
  lastTransitionTime?: string | null;
}

export interface HostMetricsOverride {
  cpuPercent?: number | null;
  memoryUsedMb?: number | null;
  memoryAvailableMb?: number | null;
  memoryTotalMb?: number | null;
  load1?: number | null;
  load5?: number | null;
  load15?: number | null;
  uptimeSeconds?: number | null;
  nodeConditions?: NodeCondition[] | null;
}

/**
 * Common interface for all container runtime implementations.
 * A runtime abstracts away the differences between Docker, containerd,
 * and Kubernetes, providing a consistent API for insightd's collectors
 * and handlers.
 */
export interface ContainerRuntime {
  /** Runtime identifier — included in MQTT payload for the hub. */
  readonly name: RuntimeName;

  /** Whether this runtime supports start/stop/restart/remove actions. */
  readonly supportsActions: boolean;

  /** Whether this runtime supports image update checks against a registry. */
  readonly supportsUpdateChecks: boolean;

  /**
   * Initialize the runtime client (connect to socket, verify access, etc.).
   * Called once at agent startup. Should throw on failure.
   */
  init(): Promise<void>;

  /** List all containers (running and stopped). */
  listContainers(): Promise<ContainerInfo[]>;

  /**
   * Collect CPU/memory/network/disk I/O for the given containers.
   * Mutates and returns the input array with resource fields populated.
   * Only collects for containers with status === 'running'.
   */
  collectResources(containers: ContainerInfo[]): Promise<ContainerWithResources[]>;

  /**
   * Fetch the most recent logs for a container.
   * @param containerId Runtime-specific identifier (Docker: container ID, k8s: pod/name)
   */
  fetchLogs(containerId: string, options: LogOptions): Promise<LogEntry[]>;

  /**
   * Perform a lifecycle action on a container.
   * Only called if supportsActions is true. Throws if disabled or unsupported.
   */
  performAction(containerName: string, action: ContainerAction): Promise<ActionResult>;

  /**
   * Check for available image updates against an upstream registry.
   * Only called if supportsUpdateChecks is true.
   */
  checkImageUpdates(): Promise<ImageUpdate[]>;

  /**
   * Optional: list on-host volumes (Docker named volumes). Omitted by
   * runtimes that don't have a native volume concept (Kubernetes — where
   * volumes are cluster-scoped and visible via the API server, not the
   * per-node agent). The hub surfaces hosts without this capability as
   * "coming soon" in the Storage → Volumes tab.
   */
  listVolumes?(): Promise<VolumeInfo[]>;

  /**
   * Optional: returns a runtime-specific override for host metrics.
   * Used by containerized runtimes where /proc/* and /sys/* reflect the
   * underlying kernel rather than the node the agent reports on. The
   * scheduler merges the returned fields into the host snapshot, falling
   * back to the /proc value for any field the runtime doesn't override.
   * Returns null on failure (scheduler keeps the /proc values).
   */
  getHostMetrics?(): Promise<HostMetricsOverride | null>;

  /**
   * Optional: return per-filesystem disk usage for the host/node. When
   * defined, the scheduler uses this *instead of* the generic /proc/mounts
   * collector. Intended for containerized runtimes (Kubernetes) where
   * /proc/mounts and statfs(/host/...) can't give accurate nested-mount
   * data without `mountPropagation: HostToContainer`, and where operators
   * care about kubelet-level concepts (nodefs, imagefs) anyway.
   *
   * Returns null on failure. The scheduler treats null as "no disk data"
   * rather than falling back to the /proc collector (which would report
   * misleading numbers in k8s mode).
   */
  getDiskMetrics?(): Promise<DiskResult[] | null>;
}
