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
 *   2. Otherwise probe known socket paths
 *   3. Fall back to 'docker' if nothing is found (existing behavior)
 */
export function detectRuntime(): RuntimeName {
  if (process.env.KUBERNETES_SERVICE_HOST) {
    logger.info('runtime', 'Detected Kubernetes environment (running in-cluster)');
    return 'kubernetes';
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
