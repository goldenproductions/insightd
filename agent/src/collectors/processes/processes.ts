// agent/src/collectors/processes/processes.ts
import * as fs from 'fs';
import * as path from 'path';
import { createPublisher } from './index';
import { newState, runPollCycle } from './poller';
import { walkProc } from './procWalk';
import { viaDockerTop } from './dockerTop';
import { viaCrictl, isCrictlAvailable } from './crictl';
import type { ContainerRuntime } from '../../runtime/types';
import { DockerRuntime } from '../../runtime/docker';
import logger = require('../../../../shared/utils/logger');

interface StartOpts {
  mqtt: any;
  hostId: string;
  runtime: ContainerRuntime;
  hostRoot: string;
  config: {
    pollIntervalMs: number;
    argvMaxBytes: number;
    dockerTopTimeoutMs: number;
  };
}

function readBootTimeMs(hostRoot: string): number {
  try {
    const stat = fs.readFileSync(path.join(hostRoot, 'proc', 'stat'), 'utf8');
    const m = stat.match(/^btime (\d+)/m);
    if (m) return parseInt(m[1], 10) * 1000;
  } catch { /* fall through */ }
  return Date.now();
}

export async function startProcessCollector(opts: StartOpts) {
  const procRoot = path.join(opts.hostRoot, 'proc');
  const bootTimeMs = readBootTimeMs(opts.hostRoot);
  const isKubernetes = opts.runtime.name === 'kubernetes';
  const crictlAvailable = isKubernetes ? await isCrictlAvailable() : false;

  if (isKubernetes && !crictlAvailable) {
    logger.warn('processes', 'crictl binary not found; k8s process attribution disabled');
  }

  // Get the dockerode client if available (Docker runtime only)
  const docker = opts.runtime instanceof DockerRuntime
    ? opts.runtime.getClient()
    : null;

  const state = newState();
  const pub = createPublisher({
    mqtt: opts.mqtt,
    hostId: opts.hostId,
    bufferMaxCycles: 60,
  });

  let inFlight = false;
  setInterval(async () => {
    if (inFlight) {
      logger.warn('processes', 'previous cycle still running; skipping');
      return;
    }
    inFlight = true;
    try {
      const containers = docker
        ? await docker.listContainers({ all: false }).catch(() => [])
        : [];
      const payload = await runPollCycle(state, {
        collectDocker: () => docker
          ? viaDockerTop(docker, containers, {
              timeoutMs: opts.config.dockerTopTimeoutMs,
              bootTimeMs,
              argvMaxBytes: opts.config.argvMaxBytes,
            })
          : Promise.resolve(new Map()),
        collectK8s: () => viaCrictl({
          runtime: isKubernetes ? 'kubernetes' : 'docker',
          crictlAvailable,
          procRoot,
          bootTimeMs,
          argvMaxBytes: opts.config.argvMaxBytes,
        }),
        collectHost: (claimed) => walkProc({
          procRoot,
          bootTimeMs,
          claimedPids: claimed,
          argvMaxBytes: opts.config.argvMaxBytes,
        }),
        now: () => new Date(),
      });
      pub.publish(payload);
    } catch (err) {
      logger.error('processes', `cycle failed: ${(err as Error).message}`);
    } finally {
      inFlight = false;
    }
  }, opts.config.pollIntervalMs);
}
