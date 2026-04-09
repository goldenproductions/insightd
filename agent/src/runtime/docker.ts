import logger = require('../../../shared/utils/logger');
import type Dockerode from 'dockerode';
import https = require('https');
import type { IncomingMessage } from 'http';
import type {
  ContainerRuntime, ContainerInfo, ContainerWithResources,
  LogEntry, LogOptions, ContainerAction, ActionResult, ImageUpdate,
} from './types';

const { safeCollect } = require('../../../shared/utils/errors') as {
  safeCollect: <T>(label: string, fn: () => Promise<T>) => Promise<T | null>;
};

const VALID_ACTIONS: ContainerAction[] = ['start', 'stop', 'restart', 'remove'];

/**
 * Docker implementation of ContainerRuntime.
 * Uses dockerode to talk to the Docker Engine API.
 */
export class DockerRuntime implements ContainerRuntime {
  readonly name = 'docker' as const;
  readonly supportsActions = true;
  readonly supportsUpdateChecks = true;

  private docker: Dockerode | null = null;
  private socketPath: string;
  private allowActions: boolean;

  // In-memory state — restart tracking across collection cycles
  private restartState = new Map<string, { restartCount: number; lastStartedAt: string | null }>();
  // In-memory state — previous CPU stats for delta calculation
  private prevStats = new Map<string, Record<string, any>>();

  constructor(options: { socketPath: string; allowActions: boolean }) {
    this.socketPath = options.socketPath;
    this.allowActions = options.allowActions;
  }

  async init(): Promise<void> {
    const Docker = require('dockerode') as new (options: { socketPath: string }) => Dockerode;
    this.docker = new Docker({ socketPath: this.socketPath });
    const info = await this.docker.info();
    logger.info('docker', `Connected — ${info.Containers} containers, ${info.Images} images`);
  }

  /** Escape hatch for code that needs direct Docker access (e.g. the updater). */
  getClient(): Dockerode {
    if (!this.docker) throw new Error('DockerRuntime not initialized');
    return this.docker;
  }

  async listContainers(): Promise<ContainerInfo[]> {
    const docker = this.getClient();
    const raw = await docker.listContainers({ all: true });

    const parsed: ContainerInfo[] = raw.map(c => ({
      name: (c.Names[0] || '').replace(/^\//, ''),
      id: c.Id.slice(0, 12),
      status: c.State,
      restartCount: 0,
      healthStatus: null,
      labels: c.Labels || {},
      image: c.Image,
    }));

    // Enrich with restart counts via inspect
    for (const p of parsed) {
      try {
        const info = await docker.getContainer(p.id).inspect();
        const dockerRestarts = info.RestartCount || 0;
        const startedAt = info.State?.StartedAt;

        const prev = this.restartState.get(p.name);
        if (!prev) {
          p.restartCount = dockerRestarts;
        } else if (dockerRestarts > prev.restartCount) {
          p.restartCount = dockerRestarts;
        } else if (startedAt && info.State?.Running && prev.lastStartedAt) {
          if (startedAt !== prev.lastStartedAt) {
            p.restartCount = prev.restartCount + 1;
          } else {
            p.restartCount = prev.restartCount;
          }
        } else {
          p.restartCount = prev.restartCount;
        }

        p.healthStatus = info.State?.Health?.Status || null;

        this.restartState.set(p.name, {
          restartCount: p.restartCount,
          lastStartedAt: startedAt || null,
        });
      } catch {
        // container may have been removed between list and inspect
        const prev = this.restartState.get(p.name);
        if (prev) p.restartCount = prev.restartCount;
      }
    }

    // Clean up stale entries for removed containers
    const currentNames = new Set(parsed.map(p => p.name));
    for (const name of this.restartState.keys()) {
      if (!currentNames.has(name)) this.restartState.delete(name);
    }

    logger.info('containers', `Collected ${parsed.length} containers`);
    return parsed;
  }

  async collectResources(containers: ContainerInfo[]): Promise<ContainerWithResources[]> {
    const docker = this.getClient();
    const result = containers as ContainerWithResources[];

    for (const c of result) {
      if (c.status !== 'running') continue;

      await safeCollect(`resources:${c.name}`, async () => {
        const container = docker.getContainer(c.id);

        const stats = await Promise.race([
          container.stats({ stream: false }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Stats timeout')), 10000)
          ),
        ]) as Record<string, any>;

        // CPU %
        let cpuPercent: number | null = null;
        const prev = this.prevStats.get(c.id);
        if (prev) {
          const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - prev.cpu_stats.cpu_usage.total_usage;
          const systemDelta = stats.cpu_stats.system_cpu_usage - prev.cpu_stats.system_cpu_usage;
          const cpuCount = stats.cpu_stats.online_cpus || 1;
          if (systemDelta > 0 && cpuDelta >= 0) {
            cpuPercent = Math.round((cpuDelta / systemDelta) * cpuCount * 100 * 100) / 100;
          } else if (cpuDelta < 0) {
            cpuPercent = null;
          }
        }
        this.prevStats.set(c.id, stats);

        // Memory
        const memoryMb = Math.round((stats.memory_stats.usage || 0) / 1024 / 1024 * 100) / 100;

        // Network I/O
        let networkRxBytes: number | null = null;
        let networkTxBytes: number | null = null;
        if (stats.networks) {
          networkRxBytes = 0;
          networkTxBytes = 0;
          for (const iface of Object.values(stats.networks) as Array<{ rx_bytes?: number; tx_bytes?: number }>) {
            networkRxBytes! += iface.rx_bytes || 0;
            networkTxBytes! += iface.tx_bytes || 0;
          }
        }

        // Block I/O
        let blkioReadBytes: number | null = null;
        let blkioWriteBytes: number | null = null;
        const ioEntries = stats.blkio_stats?.io_service_bytes_recursive;
        if (Array.isArray(ioEntries) && ioEntries.length > 0) {
          blkioReadBytes = 0;
          blkioWriteBytes = 0;
          for (const entry of ioEntries as Array<{ op?: string; value?: number }>) {
            const op = (entry.op || '').toLowerCase();
            if (op === 'read') blkioReadBytes! += entry.value || 0;
            if (op === 'write') blkioWriteBytes! += entry.value || 0;
          }
        }

        c.cpuPercent = cpuPercent;
        c.memoryMb = memoryMb;
        c.networkRxBytes = networkRxBytes;
        c.networkTxBytes = networkTxBytes;
        c.blkioReadBytes = blkioReadBytes;
        c.blkioWriteBytes = blkioWriteBytes;

        logger.info('resources', `${c.name}: CPU=${cpuPercent ?? 'pending'}%, RAM=${memoryMb}MB`);
      });
    }

    // Clean up stale entries
    const currentIds = new Set(result.map(c => c.id));
    for (const id of this.prevStats.keys()) {
      if (!currentIds.has(id)) this.prevStats.delete(id);
    }

    return result;
  }

  async fetchLogs(containerId: string, options: LogOptions): Promise<LogEntry[]> {
    const { fetchContainerLogs } = require('../../../shared/utils/docker-logs') as {
      fetchContainerLogs: (docker: Dockerode, id: string, opts?: LogOptions) => Promise<LogEntry[]>;
    };
    return fetchContainerLogs(this.getClient(), containerId, options);
  }

  async performAction(containerName: string, action: ContainerAction): Promise<ActionResult> {
    if (!this.allowActions) {
      throw new Error('Container actions are disabled. Set INSIGHTD_ALLOW_ACTIONS=true to enable.');
    }
    if (!VALID_ACTIONS.includes(action)) {
      throw new Error(`Invalid action "${action}". Must be one of: ${VALID_ACTIONS.join(', ')}`);
    }

    const docker = this.getClient();
    const containers = await docker.listContainers({ all: true });
    const match = containers.find(c => c.Names.some(n => n === `/${containerName}` || n === containerName));
    if (!match) throw new Error(`Container "${containerName}" not found`);

    if (match.Labels && match.Labels['insightd.internal'] === 'true') {
      throw new Error(`Cannot ${action} internal insightd container "${containerName}"`);
    }
    if (action === 'remove' && match.State === 'running') {
      throw new Error(`Container "${containerName}" is running. Stop it before removing.`);
    }

    const container = docker.getContainer(match.Id);
    logger.info('actions', `Performing ${action} on ${containerName} (${match.Id.slice(0, 12)})`);

    if (action === 'start') await container.start();
    else if (action === 'stop') await container.stop({ t: 10 });
    else if (action === 'restart') await container.restart({ t: 10 });
    else if (action === 'remove') await container.remove();

    const past = action === 'stop' ? 'stopped' : action === 'remove' ? 'removed' : `${action}ed`;
    logger.info('actions', `${action} completed on ${containerName}`);
    return { status: 'success', message: `Container "${containerName}" ${past} successfully` };
  }

  async checkImageUpdates(): Promise<ImageUpdate[]> {
    const docker = this.getClient();
    const containers = await docker.listContainers({ all: true });
    const results: ImageUpdate[] = [];
    const seen = new Set<string>();
    let checked = 0;
    let updatesFound = 0;

    for (const c of containers) {
      const name = (c.Names[0] || '').replace(/^\//, '');
      const image = c.Image;

      if (seen.has(image)) continue;
      seen.add(image);

      await safeCollect(`updates:${name}`, async () => {
        const parsed = parseImage(image);
        if (!parsed) {
          logger.info('updates', `Skipping non-Docker Hub image: ${image}`);
          return;
        }

        const imageInfo = await docker.getImage(image).inspect();
        const localDigest = (imageInfo.RepoDigests || [])
          .find(d => d.includes(parsed.repo))
          ?.split('@')[1] || null;

        const token = await getDockerHubToken(parsed.repo);
        const remoteDigest = await getRemoteDigest(parsed.repo, parsed.tag, token);

        const hasUpdate = !!(localDigest && remoteDigest && localDigest !== remoteDigest);
        if (hasUpdate) updatesFound++;

        results.push({ containerName: name, image, localDigest, remoteDigest, hasUpdate });
        checked++;

        const status = hasUpdate ? 'UPDATE AVAILABLE' : 'up to date';
        logger.info('updates', `${name} (${image}): ${status}`);
      });
    }

    logger.info('updates', `Checked ${checked} images, ${updatesFound} updates available`);
    return results;
  }
}

// --- Docker Hub registry helpers (used by checkImageUpdates) ---

interface HttpResponse { status: number | undefined; headers: IncomingMessage['headers']; body: string }
interface HttpHeadResponse { status: number | undefined; headers: IncomingMessage['headers'] }

function httpGet(url: string, headers: Record<string, string> = {}): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (chunk: string) => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function httpHead(url: string, headers: Record<string, string> = {}): Promise<HttpHeadResponse> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'HEAD', headers }, (res) => {
      resolve({ status: res.statusCode, headers: res.headers });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

export function parseImage(image: string): { repo: string; tag: string } | null {
  const noDigest = image.split('@')[0];
  const parts = noDigest.split(':');
  const tag = parts.length > 1 ? parts[parts.length - 1] : 'latest';
  let repo = parts.slice(0, -1).join(':') || parts[0];

  if (!repo.includes('/')) {
    repo = `library/${repo}`;
  }

  const firstPart = repo.split('/')[0];
  if (firstPart.includes('.')) {
    return null;
  }

  return { repo, tag };
}

async function getDockerHubToken(repo: string): Promise<string> {
  const url = `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`;
  const res = await httpGet(url);
  if (res.status !== 200) throw new Error(`Auth failed: ${res.status}`);
  return JSON.parse(res.body).token;
}

async function getRemoteDigest(repo: string, tag: string, token: string): Promise<string | null> {
  const url = `https://registry-1.docker.io/v2/${repo}/manifests/${tag}`;
  const res = await httpHead(url, {
    Authorization: `Bearer ${token}`,
    Accept: [
      'application/vnd.docker.distribution.manifest.v2+json',
      'application/vnd.docker.distribution.manifest.list.v2+json',
      'application/vnd.oci.image.index.v1+json',
    ].join(', '),
  });
  if (res.status === 429) throw new Error('Rate limited by Docker Hub');
  if (res.status !== 200) throw new Error(`Registry returned ${res.status}`);
  return (res.headers['docker-content-digest'] as string) || null;
}
