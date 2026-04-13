/**
 * Correlation-based diagnosis framework types.
 *
 * A diagnoser is a pure function that takes a DiagnosisContext (pre-assembled
 * signals from the DB) and returns zero or more structured Findings. Findings
 * have a conclusion, evidence, a suggested action, and confidence level —
 * designed to give operators actionable insight into WHY something is wrong,
 * not just WHAT is wrong.
 */

export interface BaselineRow {
  metric: string;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
  mad: number | null;
  mad_sample_count: number | null;
  sample_count: number;
}

export interface DiagnosisEntity {
  type: 'container';
  hostId: string;
  containerName: string;
}

export interface ContainerSnapshotRow {
  status: string;
  cpu_percent: number | null;
  memory_mb: number | null;
  restart_count: number;
  health_status: string | null;
  health_check_output: string | null;
  collected_at: string;
}

export type TrendDirection = 'rising' | 'falling' | 'stable';
export type BaselineComparison = 'normal' | 'elevated' | 'critical' | null;

export interface DiagnosisLatest {
  status: string;
  cpuPercent: number | null;
  memoryMb: number | null;
  restartCount: number;
  healthStatus: string | null;
  healthCheckOutput: string | null;
  collectedAt: string;
}

export interface DiagnosisRecent {
  snapshots: ContainerSnapshotRow[];
  cpuTrend: TrendDirection;
  memoryTrend: TrendDirection;
  restartsInWindow: number;
}

export interface DiagnosisUnhealthyEpisode {
  since: string | null;
  durationMinutes: number | null;
}

export interface DiagnosisHostState {
  healthScore: number | null;
  cpuPercent: number | null;
  memoryPercent: number | null;
  load5: number | null;
  underPressure: boolean;
}

export interface DiagnosisAlertRow {
  alert_type: string;
  target: string;
  triggered_at: string;
}

export interface DiagnosisCoincident {
  activeAlerts: DiagnosisAlertRow[];
  recentFailures: string[];
  cascadeDetected: boolean;
}

export interface DiagnosisLogEntry {
  stream: 'stdout' | 'stderr';
  timestamp: string | null;
  message: string;
}

/**
 * A log template hit in the current batch — one entry per distinct template
 * that appeared, with its count and semantic tag (if Drain's overlay classified
 * it). `isNew` is true when this template was created by the current batch
 * (i.e. not seen in DB before).
 */
export interface TemplateHit {
  templateHash: string;
  template: string;
  count: number;
  semanticTag: string | null;
  isNew: boolean;
}

/**
 * A template that is appearing far more frequently than its historical rate.
 * Computed from comparing batch count to the stored occurrence_count delta.
 */
export interface TemplateBurst {
  templateHash: string;
  template: string;
  burstCount: number;
  semanticTag: string | null;
}

export interface DiagnosisLogs {
  available: boolean;
  lines: DiagnosisLogEntry[];
  /**
   * Deprecated — retained for back-compat with older diagnosers that read
   * string labels. New code should read `templates` instead. Phase 1 of the
   * diagnosis upgrade populates this from the Drain semantic overlay.
   */
  errorPatterns: string[];
  templates: TemplateHit[];
  unseenTemplates: number;
  templateBursts: TemplateBurst[];
  fetchedAt: string | null;
}

export interface DiagnosisContext {
  entity: DiagnosisEntity;
  now: Date;
  latest: DiagnosisLatest;
  recent: DiagnosisRecent;
  baselines: Record<string, BaselineRow>;
  memoryVsP95: BaselineComparison;
  cpuVsP95: BaselineComparison;
  unhealthy: DiagnosisUnhealthyEpisode;
  host: DiagnosisHostState;
  coincident: DiagnosisCoincident;
  logs: DiagnosisLogs;
}

/**
 * A structured fact detected about an entity. Phase 3 replaces the old
 * decision tree with per-signal detectors that each return one of these;
 * the unified diagnoser fuses them into a single Finding. The `kind` field
 * is consumed by Phase 4's evidence ranking to compute surprise scores.
 */
export interface FindingSignal {
  kind:
    | 'oom_risk'
    | 'oom_confirmed'
    | 'crash_loop'
    | 'cascade'
    | 'host_pressure'
    | 'app_errors'
    | 'zombie_listener'
    | 'hung_service'
    | 'ppr_root'
    | 'fallback';
  severity: 'critical' | 'warning' | 'info';
  confidence: 'high' | 'medium' | 'low';
  /** Short headline for this signal (used as finding conclusion when primary). */
  conclusion: string;
  /** Suggested action if this signal is the primary explanation. */
  action: string;
  /** Supporting evidence lines to show the user. */
  evidence: string[];
  /**
   * Decision-tree priority: lower = more specific, wins when multiple
   * signals fire. Mirrors the ordering of the old 9-branch tree.
   */
  priority: number;
}

/**
 * One neighbor returned by the personalized-PageRank RCA pass — an upstream
 * or sideways entity that correlates with the symptom container.
 */
export interface Neighbor {
  entityId: string;
  score: number;
  edgeTypes: string[];
}

export interface PPRResult {
  seed: string;
  neighbors: Neighbor[];
}

export interface Finding {
  diagnoser: string;
  severity: 'critical' | 'warning' | 'info';
  confidence: 'high' | 'medium' | 'low';
  conclusion: string;
  evidence: string[];
  suggestedAction: string;
  /**
   * ISO timestamp for when this conclusion was first reached. Populated by
   * the sticky-findings layer in `run.ts` — while the conclusion + severity
   * stay the same, this value is frozen, so the UI can show a stable
   * "Analysis updated Xm ago" instead of looking like it re-ran every view.
   */
  diagnosedAt?: string;
  /**
   * Structured signals that contributed to this finding. Optional so older
   * persisted findings remain compatible; new diagnosers populate it so
   * Phase 4 evidence ranking + confidence calibration can consume typed
   * data instead of parsing evidence strings.
   */
  signals?: FindingSignal[];
}

export type Diagnoser = (ctx: DiagnosisContext) => Finding[];

export {};
