import fs = require('fs');
import cron = require('node-cron');
import logger = require('../../shared/utils/logger');
import type { ContainerRuntime } from './runtime/types';

const { safeCollect } = require('../../shared/utils/errors') as { safeCollect: <T>(label: string, fn: () => Promise<T>) => Promise<T | null> };
const { publishCollection, publishUpdates, publishPvs, publishPvcs, publishEvents, publishIngresses, publishPendingPods, publishServices } = require('./mqtt') as {
  publishCollection: (hostId: string, data: any) => Promise<void>;
  publishUpdates: (hostId: string, updates: any[]) => Promise<void>;
  publishPvs: (clusterId: string, publisherHostId: string, pvs: any[]) => Promise<void>;
  publishPvcs: (clusterId: string, publisherHostId: string, pvcs: any[]) => Promise<void>;
  publishEvents: (clusterId: string, publisherHostId: string, events: any[]) => Promise<void>;
  publishIngresses: (clusterId: string, publisherHostId: string, ingresses: any[]) => Promise<void>;
  publishPendingPods: (clusterId: string, publisherHostId: string, pods: any[]) => Promise<void>;
  publishServices: (clusterId: string, publisherHostId: string, services: any[]) => Promise<void>;
};

interface SchedulerConfig {
  hostId: string;
  hostGroup?: string;
  collectIntervalMinutes: number;
  updateCheckCron: string;
  timezone: string;
  hostRoot: string;
  diskWarnPercent?: number;
  podName?: string;
  podNamespace?: string;
  nodeName?: string;
}

interface ClusterPublisher {
  clusterId: string;
  client: import('./runtime/kubernetes').K8sClient;
  leader: import('./runtime/k8s-lease').LeaderElector;
}

function startAgentScheduler(runtime: ContainerRuntime, config: SchedulerConfig): void {
  const { collectDisk } = require('./collectors/disk') as { collectDisk: (config: any) => any[] };
  const { collectHost } = require('./collectors/host') as { collectHost: (config: any) => any };
  const { collectGpu } = require('./collectors/gpu') as { collectGpu: () => any };
  const { collectTemperature } = require('./collectors/temperature') as { collectTemperature: (config: any) => any };
  const { collectDiskIO } = require('./collectors/disk-io') as { collectDiskIO: (config: any) => any };
  const { collectNetworkIO } = require('./collectors/network-io') as { collectNetworkIO: (config: any) => any };

  const isK8s = runtime.name === 'kubernetes';
  let clusterPublisher: ClusterPublisher | null = null;

  async function runCollection(): Promise<void> {
    logger.info('scheduler', 'Starting collection cycle');

    let containers = await safeCollect('containers', () => runtime.listContainers());
    if (containers) {
      containers = await safeCollect('resources', () => runtime.collectResources(containers!));
    }

    // Runtime-provided disk metrics (Kubernetes uses kubelet /stats/summary
    // — /proc/mounts inside the DaemonSet can't see nested host mounts
    // without mountPropagation=HostToContainer, and nodefs/imagefs are the
    // meaningful units on a k8s node anyway). When the runtime opts in, we
    // use it exclusively; falling back to collectDisk would produce the
    // same misleading rootfs-only numbers the override is meant to avoid.
    const disk = runtime.getDiskMetrics
      ? (await safeCollect('disk', () => runtime.getDiskMetrics!())) || []
      : await safeCollect('disk', () => Promise.resolve(collectDisk(config))) || [];
    const host = await safeCollect('host', () => Promise.resolve(collectHost(config)));

    // For containerized runtimes (k8s), /proc/* and /sys/* reflect the
    // underlying machine's kernel — not the node we're reporting on. Ask
    // the runtime for an authoritative override and merge it into `host`,
    // skipping fields the runtime doesn't observe.
    let nodeConditions: import('./runtime/types').NodeCondition[] | null = null;
    if (host && runtime.getHostMetrics) {
      const override = await safeCollect('runtime-host-metrics', () => runtime.getHostMetrics!());
      if (override) {
        if (override.cpuPercent !== undefined) host.cpuPercent = override.cpuPercent;
        if (override.uptimeSeconds !== undefined) host.uptimeSeconds = override.uptimeSeconds;
        if (override.memoryUsedMb !== undefined || override.memoryAvailableMb !== undefined || override.memoryTotalMb !== undefined) {
          host.memory = host.memory || { totalMb: 0, usedMb: 0, availableMb: 0, swapTotalMb: 0, swapUsedMb: 0 };
          if (override.memoryUsedMb !== undefined) host.memory.usedMb = override.memoryUsedMb;
          if (override.memoryAvailableMb !== undefined) host.memory.availableMb = override.memoryAvailableMb;
          if (override.memoryTotalMb !== undefined) host.memory.totalMb = override.memoryTotalMb;
          // Swap is meaningless inside a k8s container — suppress
          host.memory.swapTotalMb = 0;
          host.memory.swapUsedMb = 0;
        }
        if (override.load1 !== undefined || override.load5 !== undefined || override.load15 !== undefined) {
          host.load = host.load || { load1: 0, load5: 0, load15: 0 };
          if (override.load1 !== undefined) host.load.load1 = override.load1;
          if (override.load5 !== undefined) host.load.load5 = override.load5;
          if (override.load15 !== undefined) host.load.load15 = override.load15;
        }
        if (override.nodeConditions !== undefined) nodeConditions = override.nodeConditions;
      }
    }

    // The remaining /proc and /sys collectors are also kernel-namespace.
    // In k8s mode they read the underlying machine's view, which is wrong
    // for the node we're reporting on. Skip them entirely — better to
    // emit NULL than a misleading value.
    const gpu = isK8s ? null : await safeCollect('gpu', () => Promise.resolve(collectGpu()));
    const temperature = isK8s ? null : await safeCollect('temperature', () => Promise.resolve(collectTemperature(config)));
    const diskIO = isK8s ? null : await safeCollect('disk-io', () => Promise.resolve(collectDiskIO(config)));
    const networkIO = isK8s ? null : await safeCollect('network-io', () => Promise.resolve(collectNetworkIO(config)));

    // Volumes: only runtimes that opt in (Docker). k8s volumes are
    // cluster-scoped and aren't visible per-node.
    const volumes = runtime.listVolumes
      ? (await safeCollect('volumes', () => runtime.listVolumes!())) ?? []
      : [];

    // K8s cluster-scoped inventory (PVs, PVCs, Events, Ingresses, Pending pods,
    // Services) — only the elected leader publishes so we don't duplicate
    // streams from every node-agent.
    if (clusterPublisher && clusterPublisher.leader.isLeader()) {
      const { collectPvs, collectPvcs, collectEvents, collectIngresses, collectPendingPods, collectServices } = require('./collectors/k8s-cluster') as {
        collectPvs: (c: any) => Promise<any[]>;
        collectPvcs: (c: any) => Promise<any[]>;
        collectEvents: (c: any) => Promise<any[]>;
        collectIngresses: (c: any) => Promise<any[]>;
        collectPendingPods: (c: any) => Promise<any[]>;
        collectServices: (c: any) => Promise<any[]>;
      };
      const pvs = await safeCollect('pvs', () => collectPvs(clusterPublisher!.client));
      const pvcs = await safeCollect('pvcs', () => collectPvcs(clusterPublisher!.client));
      const events = await safeCollect('events', () => collectEvents(clusterPublisher!.client));
      const ingresses = await safeCollect('ingresses', () => collectIngresses(clusterPublisher!.client));
      const pendingPods = await safeCollect('pending-pods', () => collectPendingPods(clusterPublisher!.client));
      const services = await safeCollect('services', () => collectServices(clusterPublisher!.client));
      if (pvs) await safeCollect('mqtt-pvs', () => publishPvs(clusterPublisher!.clusterId, config.hostId, pvs));
      if (pvcs) await safeCollect('mqtt-pvcs', () => publishPvcs(clusterPublisher!.clusterId, config.hostId, pvcs));
      if (events && events.length > 0) {
        await safeCollect('mqtt-events', () => publishEvents(clusterPublisher!.clusterId, config.hostId, events));
      }
      // Publish ingresses, pending pods, services on every leader cycle
      // (including empty arrays) so the hub can prune rows that disappeared
      // since the last batch — same registry pattern as `containers`.
      if (ingresses) await safeCollect('mqtt-ingresses', () => publishIngresses(clusterPublisher!.clusterId, config.hostId, ingresses));
      if (pendingPods) await safeCollect('mqtt-pending-pods', () => publishPendingPods(clusterPublisher!.clusterId, config.hostId, pendingPods));
      if (services) await safeCollect('mqtt-services', () => publishServices(clusterPublisher!.clusterId, config.hostId, services));
    }

    logger.info('scheduler', 'Collection cycle complete');

    // Publish to MQTT
    if (containers) {
      await safeCollect('mqtt-publish', () =>
        publishCollection(config.hostId, { containers, disk, volumes, host, gpu, temperature, diskIO, networkIO, nodeConditions, runtimeName: runtime.name, hostGroup: config.hostGroup })
      );
    }

    // Write health file for Docker HEALTHCHECK
    try { fs.writeFileSync('/tmp/insightd-healthy', ''); } catch { /* ignore */ }
  }

  // Set up the cluster-scoped publisher once per process (k8s only, leader-elected).
  if (isK8s) {
    const k8sRuntime = runtime as any as { coreApi?: import('./runtime/kubernetes').K8sClient | null };
    if (!config.podNamespace || !config.podName) {
      logger.warn('scheduler', 'POD_NAMESPACE or POD_NAME missing — skipping PV/PVC publisher (set via downward API)');
    } else if (!k8sRuntime.coreApi) {
      logger.warn('scheduler', 'K8s coreApi not available — skipping PV/PVC publisher');
    } else {
      const { createLeaderElector } = require('./runtime/k8s-lease') as typeof import('./runtime/k8s-lease');
      const clusterId = config.hostGroup && config.hostGroup.length > 0
        ? config.hostGroup
        : `cluster-${config.nodeName || config.hostId}`;
      const leader = createLeaderElector({
        client: k8sRuntime.coreApi,
        namespace: config.podNamespace,
        leaseName: 'insightd-pv-publisher',
        identity: config.podName,
      });
      leader.start();
      clusterPublisher = { clusterId, client: k8sRuntime.coreApi, leader };
      logger.info('scheduler', `Cluster publisher active — clusterId="${clusterId}", identity="${config.podName}"`);
      // Best-effort release on SIGTERM so DaemonSet rollouts hand off instantly.
      const onShutdown = async (): Promise<void> => { try { await leader.stop(); } catch { /* ignore */ } };
      process.once('SIGTERM', onShutdown);
      process.once('SIGINT',  onShutdown);
    }
  }

  // Run immediately
  runCollection();

  // Schedule collection
  const collectCron = `*/${config.collectIntervalMinutes} * * * *`;
  cron.schedule(collectCron, runCollection, { timezone: config.timezone });
  logger.info('scheduler', `Collection scheduled: ${collectCron}`);

  // Schedule update checks (only if the runtime supports them)
  if (runtime.supportsUpdateChecks) {
    cron.schedule(config.updateCheckCron, async () => {
      logger.info('scheduler', 'Checking for image updates...');
      const updates = await safeCollect('updates', () => runtime.checkImageUpdates());
      if (updates && updates.length > 0) {
        await safeCollect('mqtt-updates', () =>
          publishUpdates(config.hostId, updates)
        );
      }
    }, { timezone: config.timezone });
    logger.info('scheduler', `Update checks scheduled: ${config.updateCheckCron}`);
  } else {
    logger.info('scheduler', `Update checks disabled for ${runtime.name} runtime`);
  }
}

module.exports = { startAgentScheduler };
