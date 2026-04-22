export const queryKeys = {
  // Health
  health: () => ['health'] as const,

  // Dashboard
  dashboard: (showInternal?: boolean) => ['dashboard', showInternal] as const,
  rankings: () => ['rankings'] as const,

  // Hosts
  hosts: () => ['hosts'] as const,
  host: (hostId?: string, showInternal?: boolean) => ['host', hostId, showInternal] as const,
  hostContainers: (hostId?: string, showInternal?: boolean) => ['host-containers', hostId, showInternal] as const,
  timeline: (hostId?: string) => ['timeline', hostId] as const,
  trends: (hostId?: string) => ['trends', hostId] as const,
  events: (hostId?: string) => ['events', hostId] as const,
  hostMetricsHistory: (hostId?: string) => ['host-metrics-history', hostId] as const,

  // Containers
  container: (hostId?: string, containerName?: string) => ['container', hostId, containerName] as const,
  containerAvailability: (hostId?: string, containerName?: string) => ['container-availability', hostId, containerName] as const,

  // Baselines
  hostBaselines: (hostId?: string) => ['baselines', 'host', hostId] as const,
  containerBaselines: (hostId?: string, containerName?: string) => ['baselines', 'container', hostId, containerName] as const,

  // Alerts & Insights
  alerts: () => ['alerts'] as const,
  insights: () => ['insights'] as const,
  insightFeedback: () => ['insight-feedback'] as const,
  aiDiagnoseStatus: () => ['ai-diagnose-status'] as const,
  aiDiagnose: (hostId?: string, containerName?: string) => ['ai-diagnose', hostId, containerName] as const,

  // Endpoints
  endpoints: () => ['endpoints'] as const,
  endpoint: (endpointId?: string) => ['endpoint', endpointId] as const,
  endpointChecks: (endpointId?: string) => ['endpoint-checks', endpointId] as const,

  // Containers (container listing keyed by host)
  allContainers: (hostKey?: string) => ['all-containers', hostKey] as const,

  // Webhooks
  webhooks: () => ['webhooks'] as const,
  webhook: (webhookId?: string) => ['webhook', webhookId] as const,

  // Settings & Admin
  settings: () => ['settings'] as const,
  apiKeys: () => ['api-keys'] as const,
  agentSetup: () => ['agent-setup'] as const,

  // Updates
  versionCheck: () => ['version-check'] as const,
  imageUpdates: () => ['image-updates'] as const,

  // Storage (DB stats for Settings card)
  storage: () => ['storage'] as const,

  // Disks (fleet disk overview)
  disks: () => ['disks'] as const,

  // Volume inventory (Storage → Volumes tab)
  volumes: () => ['volumes'] as const,

  // Kubernetes PV/PVC inventory (Storage → Volumes tab, k8s mode)
  pvs: () => ['pvs'] as const,

  // Status
  publicStatus: () => ['public-status'] as const,
} as const;
