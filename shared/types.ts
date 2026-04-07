import type Database from 'better-sqlite3';

export interface Alert {
  type: string;
  hostId: string;
  target: string;
  message: string;
  value: string;
  reminderNumber: number;
  isResolution: boolean;
}

export interface WebhookRow {
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

export interface WebhookCreateData {
  name: string;
  type: string;
  url: string;
  secret?: string | null;
  onAlert?: boolean;
  onDigest?: boolean;
  enabled?: boolean;
}

export interface WebhookUpdateData {
  name?: string;
  type?: string;
  url?: string;
  secret?: string | null;
  onAlert?: boolean;
  onDigest?: boolean;
  enabled?: boolean;
}

export interface DigestData {
  overallStatus: string;
  weekNumber: number;
  summaryLine: string;
  overallUptime: number;
  totalRestarts: number;
  hostCount: number;
  diskWarnings?: Array<{ mount_point: string }>;
  endpoints?: Array<{ name: string; uptimePercent: number | null }>;
}

export interface LogEntry {
  stream: 'stdout' | 'stderr';
  timestamp: string | null;
  message: string;
}

export interface WebhookResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export interface WebhookDispatchResult extends WebhookResult {
  webhook: string;
}

/** Re-export Database type for convenience */
export type { Database };
