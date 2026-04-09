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
  labels: Record<string, string>;
  /** Image reference — used for update checks. Optional. */
  image?: string;
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
export interface HostMetricsOverride {
  cpuPercent?: number | null;
  memoryUsedMb?: number | null;
  memoryAvailableMb?: number | null;
  memoryTotalMb?: number | null;
  load1?: number | null;
  load5?: number | null;
  load15?: number | null;
  uptimeSeconds?: number | null;
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
   * Optional: returns a runtime-specific override for host metrics.
   * Used by containerized runtimes where /proc/* and /sys/* reflect the
   * underlying kernel rather than the node the agent reports on. The
   * scheduler merges the returned fields into the host snapshot, falling
   * back to the /proc value for any field the runtime doesn't override.
   * Returns null on failure (scheduler keeps the /proc values).
   */
  getHostMetrics?(): Promise<HostMetricsOverride | null>;
}
