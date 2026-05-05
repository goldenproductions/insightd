import fs = require('fs');
import logger = require('../../../shared/utils/logger');
import type { RuntimeName } from './types';

/**
 * Candidate sockets probed during auto-detection, in priority order.
 * k3s and containerd sockets come first because if both Docker and
 * containerd are present, the user is more likely to want containerd.
 */
const SOCKET_PROBES: Array<{ path: string; runtime: RuntimeName }> = [
  // k3s's containerd socket
  { path: '/run/k3s/containerd/containerd.sock', runtime: 'containerd' },
  // Standard containerd socket
  { path: '/run/containerd/containerd.sock', runtime: 'containerd' },
  // Docker socket
  { path: '/var/run/docker.sock', runtime: 'docker' },
];

/**
 * Detect which container runtime is available on the host.
 *
 * Resolution order:
 *   1. If KUBERNETES_SERVICE_HOST env var is set (running in a pod), use 'kubernetes'
 *   2. If pmxcfs is mounted (/etc/pve/.version exists), this is a Proxmox VE node
 *   3. Otherwise probe known container runtime socket paths
 *   4. Fall back to 'docker' if nothing is found (existing behavior)
 *
 * Note for PVE REST API mode: that mode runs the agent OFF the hypervisor,
 * so this probe never matches. Operators using REST mode must set
 * `INSIGHTD_RUNTIME=proxmox` explicitly. See docs/proxmox-setup.md.
 */
export function detectRuntime(): RuntimeName {
  if (process.env.KUBERNETES_SERVICE_HOST) {
    logger.info('runtime', 'Detected Kubernetes environment (running in-cluster)');
    return 'kubernetes';
  }

  // Proxmox VE: pmxcfs mounts /etc/pve/.version on every cluster node, even
  // single-node "clusters of one". A stronger signal than any binary path
  // because pmxcfs only mounts when pve-cluster.service is up.
  try {
    if (fs.existsSync('/etc/pve/.version')) {
      let dockerAlsoPresent = false;
      try { dockerAlsoPresent = fs.existsSync('/var/run/docker.sock'); } catch { /* ignore */ }
      if (dockerAlsoPresent) {
        logger.warn(
          'runtime',
          'Detected Proxmox VE — but /var/run/docker.sock is also present. ' +
          'Defaulting to proxmox; set INSIGHTD_RUNTIME=docker to override.'
        );
      } else {
        logger.info('runtime', 'Detected Proxmox VE via /etc/pve/.version');
      }
      return 'proxmox';
    }
  } catch {
    // permission denied or similar — keep probing
  }

  for (const probe of SOCKET_PROBES) {
    try {
      if (fs.existsSync(probe.path)) {
        logger.info('runtime', `Detected ${probe.runtime} via ${probe.path}`);
        return probe.runtime;
      }
    } catch {
      // permission denied or similar — keep probing
    }
  }

  logger.warn('runtime', 'No container runtime detected, falling back to docker');
  return 'docker';
}
