/**
 * Derive how a container's status should be presented in the UI, accounting
 * for exit codes. A one-shot container that exited with code 0 is "completed"
 * (grey), not a failure (red). Non-zero exits stay "exited" (red). Running
 * containers are unchanged.
 */
export function deriveContainerDisplayStatus(
  status: string,
  exitCode: number | null | undefined,
): { label: string; color: 'green' | 'red' | 'gray' | 'yellow'; dot: string } {
  if (status === 'running') return { label: 'running', color: 'green', dot: 'running' };
  if (status === 'exited' && exitCode === 0) {
    return { label: 'completed', color: 'gray', dot: 'none' };
  }
  if (status === 'exited' && exitCode != null && exitCode !== 0) {
    return { label: `exited (${exitCode})`, color: 'red', dot: 'exited' };
  }
  // Fallback: status string as-is. Covers 'created', 'paused', 'restarting',
  // or a pre-v28 snapshot with no exit_code.
  return { label: status, color: 'red', dot: status };
}

/**
 * Check if a container is insightd infrastructure based on its labels.
 */
export function isInternalContainer(labels: string | null | undefined): boolean {
  if (!labels) return false;
  try {
    const parsed = typeof labels === 'string' ? JSON.parse(labels) : labels;
    return parsed['insightd.internal'] === 'true';
  } catch {
    return false;
  }
}

/**
 * Extract the Kubernetes namespace from a container_name.
 * K8s names follow "namespace/stableName/container" (two slashes).
 * Returns null for Docker containers (no slashes).
 */
export function getContainerNamespace(containerName: string): string | null {
  const slash = containerName.indexOf('/');
  if (slash <= 0) return null;
  return containerName.slice(0, slash);
}

/**
 * Strip the namespace prefix from a k8s container_name, returning
 * "stableName/container". Returns the full name for Docker containers.
 */
export function getContainerDisplayName(containerName: string): string {
  const slash = containerName.indexOf('/');
  if (slash <= 0) return containerName;
  return containerName.slice(slash + 1);
}

/**
 * Split a container entity_id of the form "hostId/containerName". k8s
 * container names are themselves slashed ("namespace/pod/container"), so
 * splitting naively on '/' and taking two parts loses everything after the
 * first slash. This helper peels off the host prefix and returns the rest
 * as-is, so the link and display name stay correct for both Docker and k8s.
 *
 * Returns null when the id doesn't look like "host/something".
 */
export function splitContainerEntityId(
  entityId: string,
): { hostId: string; containerName: string } | null {
  const slash = entityId.indexOf('/');
  if (slash <= 0 || slash === entityId.length - 1) return null;
  return {
    hostId: entityId.slice(0, slash),
    containerName: entityId.slice(slash + 1),
  };
}

/**
 * Count restarts over a history window by summing positive deltas between
 * consecutive snapshots. Robust to counter resets (Docker container
 * recreation, k8s pod recreation, agent restart) — a naive last-minus-first
 * would undercount when the counter drops to zero mid-window.
 *
 * Mirrors the backend logic in hub/src/insights/diagnosis/context.ts so the
 * hero metric and the diagnosis engine's restart count stay in sync.
 */
export function sumPositiveRestartDeltas(
  history: ReadonlyArray<{ restart_count: number }>,
): number {
  let total = 0;
  for (let i = 1; i < history.length; i++) {
    const delta = history[i]!.restart_count - history[i - 1]!.restart_count;
    if (delta > 0) total += delta;
  }
  return total;
}
