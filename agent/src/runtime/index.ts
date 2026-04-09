import logger = require('../../../shared/utils/logger');
import type { ContainerRuntime, RuntimeName } from './types';
import { DockerRuntime } from './docker';
import { detectRuntime } from './detect';

export interface RuntimeOptions {
  /** Explicit runtime choice, or 'auto' to detect. */
  runtime: RuntimeName | 'auto';
  /** Docker socket path (only used when runtime === 'docker'). */
  dockerSocket: string;
  /** Whether to allow start/stop/restart/remove actions. */
  allowActions: boolean;
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
      throw new Error('containerd runtime not yet implemented (planned for Phase 2)');
    case 'kubernetes':
      throw new Error('kubernetes runtime not yet implemented (planned for Phase 3)');
    default:
      throw new Error(`Unknown runtime: ${resolved}`);
  }

  await runtime.init();
  return runtime;
}

export type { ContainerRuntime, RuntimeName } from './types';
export { DockerRuntime } from './docker';
