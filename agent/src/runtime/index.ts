import logger = require('../../../shared/utils/logger');
import type { ContainerRuntime, RuntimeName } from './types';
import { DockerRuntime } from './docker';
import { KubernetesRuntime } from './kubernetes';
import { ProxmoxRuntime } from './proxmox';
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
  /** Explicit kubelet URL override. From INSIGHTD_KUBELET_URL env. */
  kubeletUrl?: string;
  /** PVE REST API base URL — when set, ProxmoxRuntime uses HTTPS instead
   *  of shelling local pvesh. From INSIGHTD_PVE_API_URL env. */
  pveApiUrl?: string;
  /** PVE token id `user@realm!tokenid`. Required in REST mode. */
  pveTokenId?: string;
  /** PVE token secret. Required in REST mode. */
  pveTokenSecret?: string;
  /** Default false (matches pvesh --insecure). Set true with a real CA. */
  pveVerifyTls?: boolean;
  /** Path to CA bundle PEM. Only consulted when pveVerifyTls=true. */
  pveCaBundle?: string;
  /** PVE node name this agent is responsible for. Required in REST mode. */
  pveNode?: string;
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
        kubeletUrl: options.kubeletUrl,
      });
      break;
    case 'proxmox':
      runtime = new ProxmoxRuntime({
        allowActions: options.allowActions,
        api: options.pveApiUrl ? {
          url: options.pveApiUrl,
          tokenId: options.pveTokenId,
          tokenSecret: options.pveTokenSecret,
          verifyTls: options.pveVerifyTls,
          caBundle: options.pveCaBundle,
        } : undefined,
        nodeName: options.pveNode,
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
export { ProxmoxRuntime } from './proxmox';
