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
  groups: ServiceGroupSummary[];
  systemHealthScore: {
    score: number;
    factors: Record<string, unknown>;
    hostBreakdown: { hostId: string; score: number; factors: Record<string, { score: number; weight: number; value: number | string; rating: string }> }[];
    computedAt: string;
  } | null;
  topInsights: DashboardInsight[];
  availability: { overallPercent: number | null; downContainers: { hostId: string; name: string; uptimePercent: number; downMinutes: number }[] };
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
  collected_at: string;
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

export interface HostDetail extends Host {
  containers: ContainerSnapshot[];
  disk: DiskSnapshot[];
  alerts: Alert[];
  updates: UpdateCheck[];
  hostMetrics: HostMetrics | null;
  diskForecast: DiskForecastItem[];
  /** v26 — recent S-H-ESD rollup anomalies for this host. */
  anomalies?: RollupAnomaly[];
}

// Alerts
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
export interface PublicStatus {
  title: string;
  overallStatus: 'operational' | 'degraded' | 'outage';
  groups: { id: number; name: string; icon: string | null; color: string | null;
    members: { container_name: string; host_id: string; status: string | null }[];
    running_count: number; member_count: number }[];
  endpoints: { name: string; url: string; is_up: boolean | null;
    uptimePercent24h: number | null; avgResponseMs: number | null;
    lastCheckedAt: string | null }[];
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
  created_at: string;
  updated_at: string;
}

export interface EndpointSummary extends Endpoint {
  lastCheck: EndpointCheck | null;
  uptimePercent24h: number | null;
  avgResponseMs: number | null;
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

// Service Groups
export interface ServiceGroup {
  id: number;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  source: 'manual' | 'compose' | 'label';
  created_at: string;
  updated_at: string;
}

export interface ServiceGroupSummary extends ServiceGroup {
  member_count: number;
  running_count: number;
  total_cpu: number | null;
  total_memory: number | null;
}

export interface ServiceGroupMember {
  host_id: string;
  container_name: string;
  source: 'manual' | 'compose' | 'label';
  container_id: string | null;
  status: string | null;
  cpu_percent: number | null;
  memory_mb: number | null;
  restart_count: number | null;
  health_status: string | null;
  collected_at: string | null;
}

export interface ServiceGroupDetail extends ServiceGroup {
  members: ServiceGroupMember[];
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
