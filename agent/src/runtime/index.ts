import logger = require('../../../shared/utils/logger');
import type { ContainerRuntime, RuntimeName } from './types';
import { DockerRuntime } from './docker';
import { KubernetesRuntime } from './kubernetes';
import { detectRuntime } from './detect';

export interface RuntimeOptions {
  /** Explicit runtime choice, or 'auto' to detect. */
  runtime: RuntimeName | 'auto';
  /** Docker socket path (only used when runtime === 'docker'). */
  dockerSocket: string;
  /** Whether to allow start/stop/restart/remove actions. */
  allowActions: boolean;
  /** K8s node name (required when runtime === 'kubernetes'). From NODE_NAME env. */
  nodeName?: string;
  /** K8s node IP (optional, used to construct kubelet URL). From NODE_IP env. */
  nodeIp?: string;
}

/**
 * Create and initialize a ContainerRuntime based on configuration.
 * Calls init() on the returned runtime, so it's ready to use immediately.
 */
export async function getRuntime(options: RuntimeOptions): Promise<ContainerRuntime> {
  const resolved: RuntimeName = options.runtime === 'auto' ? detectRuntime() : options.runtime;
  logger.info('runtime', `Using runtime: ${resolved}`);

  let runtime: ContainerRuntime;
  switch (resolved) {
    case 'docker':
      runtime = new DockerRuntime({
        socketPath: options.dockerSocket,
        allowActions: options.allowActions,
      });
      break;
    case 'containerd':
      throw new Error('containerd runtime is not supported. Use docker or kubernetes.');
    case 'kubernetes':
      if (!options.nodeName) {
        throw new Error('Kubernetes runtime requires NODE_NAME env var (set via downward API in DaemonSet)');
      }
      runtime = new KubernetesRuntime({
        nodeName: options.nodeName,
        nodeIp: options.nodeIp,
      });
      break;
    default:
      throw new Error(`Unknown runtime: ${resolved}`);
  }

  await runtime.init();
  return runtime;
}

export type { ContainerRuntime, RuntimeName } from './types';
export { DockerRuntime } from './docker';
export { KubernetesRuntime } from './kubernetes';
