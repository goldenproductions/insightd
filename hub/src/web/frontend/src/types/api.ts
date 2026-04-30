// Health
export interface HealthData {
  status: string;
  uptime: number;
  version: string;
  schemaVersion: number;
  authEnabled: boolean;
  mode: 'hub' | 'standalone';
}

// Dashboard
export interface DashboardInsight {
  entity_type: string;
  entity_id: string;
  category: string;
  severity: string;
  title: string;
  message: string;
  evidence?: string | null;
}

export interface RecentActivityItem {
  time: string;
  type: 'alert_triggered' | 'alert_resolved' | 'insight';
  host_id: string;
  target: string;
  message: string;
  tone: 'danger' | 'warning' | 'success' | 'info' | 'muted';
}

export interface DashboardData {
  hostCount: number;
  hostsOnline: number;
  hostsOffline: number;
  totalContainers: number;
  containersRunning: number;
  containersDown: number;
  activeAlerts: number;
  activeAlertsList: Alert[];
  diskWarnings: number;
  updatesAvailable: number;
  endpointsTotal: number;
  endpointsUp: number;
  endpointsDown: number;
  systemHealthScore: {
    score: number;
    factors: Record<string, unknown>;
    hostBreakdown: { hostId: string; score: number; factors: Record<string, { score: number; weight: number; value: number | string; rating: string }> }[];
    computedAt: string;
  } | null;
  topInsights: DashboardInsight[];
  availability: { overallPercent: number | null };
  recentActivity: RecentActivityItem[];
}

export interface RankingItem {
  host_id: string;
  container_name: string;
  cpu_percent: number | null;
  memory_mb: number | null;
}

export interface Rankings {
  byCpu: RankingItem[];
  byMemory: RankingItem[];
}

// Hosts
export interface Host {
  host_id: string;
  first_seen: string;
  last_seen: string;
  is_online: number;
  runtime_type?: string;
  host_group?: string | null;
  host_group_override?: string | null;
}

export interface HostMetrics {
  cpu_percent: number | null;
  memory_total_mb: number | null;
  memory_used_mb: number | null;
  memory_available_mb: number | null;
  swap_total_mb: number | null;
  swap_used_mb: number | null;
  load_1: number | null;
  load_5: number | null;
  load_15: number | null;
  uptime_seconds: number | null;
  gpu_utilization_percent: number | null;
  gpu_memory_used_mb: number | null;
  gpu_memory_total_mb: number | null;
  gpu_temperature_celsius: number | null;
  cpu_temperature_celsius: number | null;
  disk_read_bytes_per_sec: number | null;
  disk_write_bytes_per_sec: number | null;
  net_rx_bytes_per_sec: number | null;
  net_tx_bytes_per_sec: number | null;
  collected_at: string;
}

export interface HostMetricsSnapshot {
  cpu_percent: number | null;
  memory_total_mb: number | null;
  memory_used_mb: number | null;
  memory_available_mb: number | null;
  load_1: number | null;
  load_5: number | null;
  load_15: number | null;
  gpu_utilization_percent: number | null;
  gpu_temperature_celsius: number | null;
  cpu_temperature_celsius: number | null;
  disk_read_bytes_per_sec: number | null;
  disk_write_bytes_per_sec: number | null;
  net_rx_bytes_per_sec: number | null;
  net_tx_bytes_per_sec: number | null;
  collected_at: string;
}

export interface DiskSnapshot {
  mount_point: string;
  total_gb: number;
  used_gb: number;
  used_percent: number;
  collected_at: string;
}

export interface DiskForecastItem {
  mountPoint: string;
  daysUntilFull: number | null;
  dailyGrowthGb: number;
  currentPercent?: number;
}

export interface DiskOverviewMount {
  mountPoint: string;
  totalGb: number;
  usedGb: number;
  freeGb: number;
  usedPercent: number;
  collectedAt: string;
  daysUntilFull: number | null;
  dailyGrowthGb: number;
}

export interface DiskOverviewHost {
  hostId: string;
  hostGroup: string | null;
  online: boolean;
  mounts: DiskOverviewMount[];
}

export interface DiskOverviewWarning {
  hostId: string;
  mountPoint: string;
  severity: 'warning' | 'critical';
  reason: 'threshold' | 'forecast';
  usedPercent: number;
  daysUntilFull: number | null;
}

export interface DisksOverview {
  totals: { totalGb: number; usedGb: number; freeGb: number; usedPercent: number };
  hosts: DiskOverviewHost[];
  warnings: DiskOverviewWarning[];
}

export interface VolumeItem {
  name: string;
  driver: string;
  mountpoint: string | null;
  sizeBytes: number | null;
  refCount: number | null;
  createdAt: string | null;
  collectedAt: string;
}

export interface VolumesOverviewHost {
  hostId: string;
  runtimeType: string;
  hostGroup: string | null;
  online: boolean;
  volumes: VolumeItem[];
}

export interface VolumesOverview {
  totals: {
    volumeCount: number;
    totalSizeBytes: number;
    orphanedCount: number;
    orphanedSizeBytes: number;
  };
  hosts: VolumesOverviewHost[];
}

export interface PvcItem {
  namespace: string;
  name: string;
  phase: string;
  storageClass: string | null;
  requestBytes: number | null;
  capacityBytes: number | null;
  accessModes: string[];
  volumeName: string | null;
  volumeMode: string | null;
  createdAt: string | null;
}

export interface PvItem {
  name: string;
  phase: string;
  capacityBytes: number | null;
  accessModes: string[];
  reclaimPolicy: string | null;
  storageClass: string | null;
  volumeMode: string | null;
  claimRef: { namespace: string; name: string } | null;
  csiDriver: string | null;
  createdAt: string | null;
  boundPvc: PvcItem | null;
  orphaned: boolean;
}

export interface PvsOverviewCluster {
  clusterId: string;
  online: boolean;
  lastCollectedAt: string | null;
  pvs: PvItem[];
  pvcs: PvcItem[];
}

export interface PvsOverview {
  totals: {
    pvCount: number;
    boundCount: number;
    availableCount: number;
    releasedCount: number;
    failedCount: number;
    totalCapacityBytes: number;
    orphanedCount: number;
    orphanedCapacityBytes: number;
    pvcCount: number;
    pvcPendingCount: number;
    clusterCount: number;
  };
  clusters: PvsOverviewCluster[];
}

export interface UpdateCheck {
  container_name: string;
  image: string;
  has_update: number;
  checked_at: string;
}

// Containers
export interface ContainerSnapshot {
  container_name: string;
  container_id: string;
  status: string;
  cpu_percent: number | null;
  memory_mb: number | null;
  restart_count: number;
  network_rx_bytes: number | null;
  network_tx_bytes: number | null;
  blkio_read_bytes: number | null;
  blkio_write_bytes: number | null;
  health_status: string | null;
  health_check_output: string | null;
  labels: string | null;
  // Exit code for non-running containers. Null for running containers or
  // when the runtime didn't report one. 0 = completed successfully, non-zero
  // = failed.
  exit_code: number | null;
  // v36 — k8s resource limits and percent-of-limit. Null for Docker and
  // unlimited k8s containers. memory_limit_percent is hub-derived.
  cpu_limit_cores: number | null;
  cpu_limit_percent: number | null;
  memory_limit_mb: number | null;
  memory_limit_percent: number | null;
  // ISO timestamp of the most recent kernel-reported OOMKill (Docker
  // State.OOMKilled or K8s terminated.reason==='OOMKilled'). Null if never
  // observed. Used to surface a "killed by OOM" chip on the detail page.
  last_oom_killed_at: string | null;
  // v30 — container disk usage. rootfs = base image + writable layer in
  // Docker; cAdvisor's container_fs_usage_bytes for k8s. rw = writable layer
  // only. Both null when the runtime didn't report them.
  size_rootfs_bytes: number | null;
  size_rw_bytes: number | null;
  // v42 — k8s pod-level identity + status. All null for Docker.
  workload_kind: string | null;
  pod_ip: string | null;
  host_ip: string | null;
  /** JSON-stringified PodCondition[] from the agent. Frontend parses on render. */
  pod_conditions: string | null;
  collected_at: string;
  // 1 when the owning host hasn't reported within the offline threshold —
  // the snapshot is last-known state, not current truth.
  is_stale: number;
}

export interface PodCondition {
  type: string;
  status: 'True' | 'False' | 'Unknown' | string;
  reason?: string | null;
  message?: string | null;
}

export interface ContainerHistory {
  status: string;
  cpu_percent: number | null;
  memory_mb: number | null;
  restart_count: number;
  network_rx_bytes: number | null;
  network_tx_bytes: number | null;
  blkio_read_bytes: number | null;
  blkio_write_bytes: number | null;
  health_status: string | null;
  cpu_limit_cores: number | null;
  cpu_limit_percent: number | null;
  memory_limit_mb: number | null;
  collected_at: string;
}

export interface RankedEvidence {
  kind: string;
  label: string;
  surprise: number;
  explanatoryPower: number;
  score: number;
}

export interface Neighbor {
  /** camelCase fields mirror the backend Neighbor interface from
   *  hub/src/insights/diagnosis/types.ts — populated by the unified
   *  diagnoser from the PPR result, not from raw rca_edges rows. */
  entityId: string;
  score: number;
  edgeTypes: string[];
}

export interface RollupAnomaly {
  metric: string;
  bucket: string;
  value: number;
  residual: number;
  robust_z: number;
  detected_at: string;
}

export interface LogTemplate {
  template_hash: string;
  template: string;
  occurrence_count: number;
  semantic_tag: string | null;
  first_seen: string;
  last_seen: string;
}

// Baselines viewer (Explore drawer)
export type BaselineMetricUnit = 'percent' | 'mb' | 'load' | 'celsius' | 'bytes_per_sec' | 'raw';
export type BaselineCapacityKind = 'absolute' | 'capacity' | 'p95_plus' | 'none';
export type BaselineTimeBucket =
  | 'all' | 'weekday' | 'weekend'
  | 'night' | 'early_morning' | 'morning'
  | 'afternoon' | 'evening' | 'late_evening';

export interface BaselineBucket {
  time_bucket: BaselineTimeBucket;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
  min_val: number | null;
  max_val: number | null;
  mad: number | null;
  mad_sample_count: number | null;
  sample_count: number;
  /** Server-computed robust z of the live value vs this bucket. Null when mad
   *  is unknown/zero or when there is no live value. */
  live_robust_z: number | null;
  /** True for the bucket that matches "now" — current time-of-day period,
   *  weekday/weekend membership, or the catch-all 'all' bucket. */
  is_current: boolean;
}

export interface BaselineMetricView {
  metric: string;
  unit: BaselineMetricUnit;
  /** Latest live value from the most recent snapshot. Null when stale/missing. */
  live_value: number | null;
  /** Floor a live value would have to clear before an alert fires. Null for
   *  metrics that drive no alerts (network/disk i/o, gpu, temperature). */
  capacity_floor: number | null;
  capacity_floor_kind: BaselineCapacityKind;
  buckets: BaselineBucket[];
}

export interface HostBaselinesResponse {
  host_id: string;
  metrics: BaselineMetricView[];
  /** Newest computed_at across the bundle, or null if there are no rows. */
  computed_at: string | null;
}

export interface ContainerBaselinesResponse {
  host_id: string;
  container_name: string;
  metrics: BaselineMetricView[];
  computed_at: string | null;
}

export interface RcaNeighbor {
  /** "{host_id}/{container_name}" — entity key in rca_edges. */
  entity: string;
  hostId: string;
  containerName: string;
  /** Strongest edge weight in [0,1] across all edge types between this pair. */
  score: number;
  /** All edge types backing this neighbor: 'same_host' | 'same_compose' | 'metric_corr'. */
  edgeTypes: string[];
  healthStatus: string | null;
  hasActiveAlert: boolean;
  /** Container is removed from registry — link target may 404. */
  isRemoved: boolean;
}

export interface RcaNeighborsResponse {
  host_id: string;
  container_name: string;
  neighbors: RcaNeighbor[];
}

// Namespace topology — graph of workloads / pods / nodes / ingresses / pvcs
export interface TopologyContainer {
  container_name: string;
  container: string;
  status: string;
  health_status: string | null;
  has_active_alert: boolean;
}
export interface TopologyPod {
  pod_uid: string;
  host_id: string;
  containers: TopologyContainer[];
}
export interface TopologyWorkload {
  kind: string | null;
  name: string;
  total_pods: number;
  unhealthy_pods: number;
  pods_by_node: Record<string, number>;
  pods: TopologyPod[];
}
export interface TopologyIngress {
  id: number;
  name: string;
  hosts: string[];
  service_targets: string[];
}
export interface TopologyPvc {
  name: string;
  phase: string;
  capacity_bytes: number | null;
  storage_class: string | null;
}
export interface TopologyNode {
  host_id: string;
  online: boolean;
  pod_count: number;
}
export interface NamespaceTopology {
  cluster_id: string;
  namespace: string;
  workloads: TopologyWorkload[];
  ingresses: TopologyIngress[];
  pvcs: TopologyPvc[];
  nodes: TopologyNode[];
}

// Cluster overview — list of namespaces + cluster-level totals
export interface ClusterNode {
  host_id: string;
  online: boolean;
  pod_count: number;
}
export interface ClusterNamespaceSummary {
  namespace: string;
  workload_count: number;
  pod_count: number;
  unhealthy_pod_count: number;
  ingress_count: number;
  pvc_count: number;
  pvc_pending_count: number;
  active_alert_count: number;
}
export interface ClusterOverview {
  cluster_id: string;
  nodes: ClusterNode[];
  namespaces: ClusterNamespaceSummary[];
  totals: {
    nodes_online: number;
    nodes_offline: number;
    namespaces: number;
    workloads: number;
    pods: number;
    healthy_pods: number;
    unhealthy_pods: number;
    ingresses: number;
    pvcs: number;
    pvcs_pending: number;
    active_alerts: number;
  };
}

export interface Finding {
  diagnoser: string;
  severity: 'critical' | 'warning' | 'info';
  confidence: 'high' | 'medium' | 'low';
  conclusion: string;
  evidence: string[];
  suggestedAction: string;
  /** ISO timestamp. Stable while the conclusion + severity stay the same. */
  diagnosedAt?: string;
  /** Phase 4 ranked top-3 evidence (optional). */
  evidenceRanked?: RankedEvidence[];
  /** Phase 3 PPR neighbors exposed as structured data for clickable rendering. */
  neighbors?: Neighbor[];
}

export interface ContainerDetail extends ContainerSnapshot {
  host_id: string;
  /** Runtime of the host this container lives on — drives UI gating of Docker-only actions. */
  runtime_type?: 'docker' | 'kubernetes' | string;
  /** Latest image string from update_checks; null when the agent hasn't
   *  reported one yet. */
  image: string | null;
  /** Cluster id for k8s containers — host_group_override > host_group >
   *  "cluster-{hostId}". Null for Docker. */
  cluster_id: string | null;
  health_diagnosis: string | null;
  findings: Finding[];
  history: ContainerHistory[];
  alerts: Alert[];
  /** v26 — recent S-H-ESD rollup anomalies for this container. */
  anomalies?: RollupAnomaly[];
  /** v26 — Drain log templates mined for this container's image. */
  logTemplates?: LogTemplate[];
  // NOTE: per-finding PPR neighbors live on `Finding.neighbors` (camelCase).
  // The top-level `neighbors` field used to hold raw rca_edges rows, which
  // caused a shape clash — removed in fix/neighbor-type-mismatch.
}

export interface PodEvent {
  event_uid: string;
  cluster_id: string;
  namespace: string | null;
  involved_kind: string;
  involved_name: string;
  reason: string;
  message: string | null;
  type: string;
  count: number;
  first_seen_at: string;
  last_seen_at: string;
}

export interface PodEventsResponse {
  host_id: string;
  container_name: string;
  events: PodEvent[];
}

export interface HostDetail extends Host {
  containers: ContainerSnapshot[];
  disk: DiskSnapshot[];
  alerts: Alert[];
  updates: UpdateCheck[];
  hostMetrics: HostMetrics | null;
  diskForecast: DiskForecastItem[];
  /** v26 — recent S-H-ESD rollup anomalies for this host. */
  anomalies?: RollupAnomaly[];
  /** v35 — k8s node conditions (empty for non-k8s hosts). */
  nodeConditions: NodeCondition[];
}

export interface NodeCondition {
  host_id: string;
  type: string;
  status: 'True' | 'False' | 'Unknown';
  reason: string | null;
  message: string | null;
  last_heartbeat_at: string | null;
  last_transition_at: string | null;
  observed_at: string;
}

export interface HostNodeConditionsResponse {
  items: NodeCondition[];
}

// Alerts
export type AlertLevel = 'critical' | 'error' | 'warning' | 'info';

export interface AlertsExploreResponse {
  total: number;
  alerts: (Alert & { level: AlertLevel })[];
  counts: {
    byStatus: { active: number; resolved: number };
    byLevel: { critical: number; error: number; warning: number; info: number };
    byHost: { host_id: string; count: number }[];
    byNamespace: { namespace: string; count: number }[];
    byMuted: { muted: number; not_muted: number };
  };
}

export interface Alert {
  id: number;
  host_id: string;
  alert_type: string;
  target: string;
  triggered_at: string;
  resolved_at: string | null;
  last_notified: string;
  notify_count: number;
  message: string | null;
  trigger_value: string | null;
  threshold: string | null;
  silenced_until: string | null;
  silenced_by: string | null;
  silenced_at: string | null;
}

// Timeline
export interface TimelineEntry {
  name: string;
  slots: ('up' | 'down' | 'none')[];
  uptimePercent: number | null;
}

export interface TimelineResponse {
  host: TimelineEntry | null;
  containers: TimelineEntry[];
}

// Container Availability (explainable uptime)
export interface DowntimeIncident {
  start: string;
  end: string | null;
  durationMs: number | null;
  ongoing: boolean;
}

export interface ContainerAvailability {
  timeline: { slots: ('up' | 'down' | 'none')[]; uptimePercent: number | null; slotStartTime: number };
  incidents: DowntimeIncident[];
  summary: { totalHours: number; upHours: number; downHours: number; noDataHours: number; uptimePercent: number | null };
}

// Public Status Page
export type DayStatusKind = 'operational' | 'degraded' | 'outage' | 'no_data';

export interface DayStatus {
  date: string; // YYYY-MM-DD UTC
  uptimePercent: number | null;
  status: DayStatusKind;
}

export interface PublicIncident {
  id: number;
  alert_type: string;
  target: string;
  host_id: string;
  message: string | null;
  triggered_at: string;
  resolved_at: string;
  durationMinutes: number;
}

export interface PublicHost {
  host_id: string;
  is_online: boolean;
  last_seen: string | null;
  history: DayStatus[];
}

export interface PublicStatus {
  title: string;
  overallStatus: 'operational' | 'degraded' | 'outage';
  // Section arrays are present only when their `statusPage.show*` toggle is on.
  groups?: { id: number; name: string; icon: string | null; color: string | null;
    members: { container_name: string; host_id: string; status: string | null }[];
    running_count: number; member_count: number;
    history: DayStatus[] }[];
  hosts?: PublicHost[];
  endpoints?: { id: number; name: string; url: string; is_up: boolean | null;
    uptimePercent24h: number | null; avgResponseMs: number | null;
    lastCheckedAt: string | null;
    history: DayStatus[] }[];
  incidents?: PublicIncident[];
  updatedAt: string;
}

// API Keys
export interface ApiKey {
  id: number;
  name: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
}

// Container Actions
export interface ContainerActionResult {
  status: string;
  message: string;
  error?: string;
}

// Trends
export interface ContainerTrend {
  name: string;
  cpuNow: number | null;
  cpuChange: number | null;
  memNow: number | null;
  memChange: number | null;
  flagged: boolean;
}

export interface HostTrend {
  cpuNow: number | null;
  cpuChange: number | null;
  memNow: number | null;
  memChange: number | null;
  loadNow: number | null;
  loadChange: number | null;
}

export interface Trends {
  containers: ContainerTrend[];
  host: HostTrend | null;
}

// Events
export interface EventItem {
  time: string;
  type: string;
  target: string;
  message: string;
  good: boolean;
}

// Kubernetes Events (cluster-scoped, per-host view)
export interface K8sEvent {
  event_uid: string;
  cluster_id: string;
  namespace: string | null;
  involved_kind: string;
  involved_name: string;
  reason: string;
  message: string | null;
  type: string;
  count: number;
  first_seen_at: string;
  last_seen_at: string;
}

export interface HostK8sEventsResponse {
  clusterId: string | null;
  items: K8sEvent[];
}

// Endpoints
export interface Endpoint {
  id: number;
  name: string;
  url: string;
  method: string;
  expected_status: number;
  interval_seconds: number;
  timeout_ms: number;
  headers: string | null;
  enabled: number;
  /** ISO timestamp of cert `not_after`. NULL until first probe; NULL for http:// endpoints. */
  tls_expires_at: string | null;
  /** Issuer CN (or O if CN missing). */
  tls_issuer: string | null;
  /** Comma-separated SANs (DNS: prefix stripped). */
  tls_subject_alt_names: string | null;
  /** SQLite-format timestamp of the last TLS probe attempt. */
  tls_last_checked_at: string | null;
  /** `expired` | `self-signed` | `hostname-mismatch` | `untrusted-root` | `timeout` | `no-cert` | other code, or NULL when valid. */
  tls_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface EndpointSummary extends Endpoint {
  lastCheck: EndpointCheck | null;
  uptimePercent24h: number | null;
  avgResponseMs: number | null;
  /** Last ~30 checks in chronological order (oldest → newest), for the row sparkline. */
  recentChecks: { is_up: number; response_time_ms: number | null }[];
}

export interface DiscoveredIngress {
  id: number;
  clusterId: string;
  namespace: string;
  name: string;
  ingressClass: string | null;
  hosts: string[];
  paths: Array<{
    host: string;
    path: string;
    pathType: string | null;
    serviceName: string | null;
    servicePort: number | string | null;
  }>;
  tlsHosts: string[];
  externalIp: string | null;
  createdAt: string | null;
  observedAt: string;
  defaultUrl: string;
  defaultName: string;
}

export interface EndpointDetail extends Endpoint {
  uptimePercent24h: number | null;
  uptimePercent7d: number | null;
  avgResponseMs: number | null;
  lastCheck: EndpointCheck | null;
}

export interface EndpointCheck {
  id: number;
  status_code: number | null;
  response_time_ms: number | null;
  is_up: number;
  error: string | null;
  checked_at: string;
}

// Settings
export interface SettingItem {
  key: string;
  value: string;
  source: 'db' | 'env' | 'default';
  type: 'string' | 'int' | 'float' | 'bool';
  category: string;
  label: string;
  hotReload: boolean;
  sensitive: boolean;
  description: string | null;
}

export interface SettingsResponse {
  categories: Record<string, SettingItem[]>;
}

// Agent Setup
export interface AgentSetup {
  mqttUrl: string;
  mqttUser: string;
  mqttPass: string;
  image: string;
}

// Log
export interface LogLine {
  timestamp?: string;
  stream: 'stdout' | 'stderr';
  message: string;
}

export interface LogResponse {
  container: string;
  logs: LogLine[];
  error?: string;
}

// Webhooks
export interface Webhook {
  id: number;
  name: string;
  type: 'slack' | 'discord' | 'telegram' | 'ntfy' | 'generic';
  url: string;
  secret: string | null;
  on_alert: number;
  on_digest: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface WebhookTestResult {
  ok: boolean;
  status?: number;
  error?: string;
}

// Baselines
export interface BaselineRow {
  metric: string;
  time_bucket: string;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
  min_val: number | null;
  max_val: number | null;
  sample_count: number;
}

// Insights
export interface InsightRow {
  id: number;
  entity_type: string;
  entity_id: string;
  category: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  message: string;
  metric: string | null;
  current_value: number | null;
  baseline_value: number | null;
  /** JSON-encoded array of evidence strings (schema v20+). */
  evidence?: string | null;
  /** Long-form suggested action text (schema v20+). */
  suggested_action?: string | null;
  /** Calibrated confidence from the diagnoser (schema v20+). */
  confidence?: 'high' | 'medium' | 'low' | null;
  computed_at: string;
}

export interface InsightFeedback {
  entity_type: string;
  entity_id: string;
  category: string;
  metric: string | null;
  helpful: number;
  created_at: string;
}

/** Percentile subset used by analogies and ratings (no metadata fields) */
export type BaselinePercentiles = Pick<BaselineRow, 'p50' | 'p75' | 'p90' | 'p95' | 'p99'>;

// Version / Updates
export interface VersionInfo {
  currentVersion: string;
  latestHubVersion: string | null;
  latestAgentVersion: string | null;
  hubUpdateAvailable: boolean;
  checkedAt: string | null;
  /** @deprecated backward compat */
  latestVersion?: string | null;
  /** @deprecated backward compat */
  updateAvailable?: boolean;
}

export interface HostWithAgent {
  host_id: string;
  agent_version: string | null;
  is_online: number;
  runtime_type?: string;
}

export interface ImageUpdate {
  host_id: string;
  container_name: string;
  image: string;
  checked_at: string;
}

export type UpdateResult = { status: string; message?: string; error?: string };

// Storage
export interface StorageTableInfo {
  rows: number;
  oldestAt: string | null;
}

export interface StorageInfo {
  dbSizeBytes: number;
  tables: Record<string, StorageTableInfo>;
  retention: { rawDays: number; rollupDays: number };
  lastPruneAt: string | null;
  lastVacuumAt: string | null;
}

export interface VacuumResult {
  before: number;
  after: number;
  reclaimed: number;
}
