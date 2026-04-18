/**
 * Queries for the public status page (/status).
 *
 * Computes 30-day daily uptime history for each stack + endpoint by merging
 * raw snapshots (recent) with hourly rollups (historical). Also returns recent
 * resolved alerts as past incidents.
 */

import type Database from 'better-sqlite3';

export type DayStatusKind = 'operational' | 'degraded' | 'outage' | 'no_data';

export interface DayStatus {
  date: string; // YYYY-MM-DD (UTC)
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

const HISTORY_DAYS = 30;

/** Bucket a daily uptime fraction into a coarse status kind. */
function classify(upCount: number, totalCount: number): { uptimePercent: number | null; status: DayStatusKind } {
  if (totalCount === 0) return { uptimePercent: null, status: 'no_data' };
  const pct = (upCount / totalCount) * 100;
  const rounded = Math.round(pct * 10) / 10;
  if (pct >= 99) return { uptimePercent: rounded, status: 'operational' };
  if (pct >= 90) return { uptimePercent: rounded, status: 'degraded' };
  return { uptimePercent: rounded, status: 'outage' };
}

/** Build a 30-element array indexed oldest→newest, aligned to UTC days. */
function emptyHistory(): { date: string; up: number; total: number }[] {
  const out: { date: string; up: number; total: number }[] = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    out.push({ date: d.toISOString().slice(0, 10), up: 0, total: 0 });
  }
  return out;
}

function fillDays(rows: { day: string; up: number; total: number }[]): DayStatus[] {
  const buckets = emptyHistory();
  const byDay = new Map(buckets.map((b, i) => [b.date, i]));
  for (const r of rows) {
    const i = byDay.get(r.day);
    if (i == null) continue;
    buckets[i].up += r.up;
    buckets[i].total += r.total;
  }
  return buckets.map(b => ({ date: b.date, ...classify(b.up, b.total) }));
}

interface DayCountRow { day: string; up: number; total: number }

/** 30-day daily uptime for one stack (aggregated across all member containers). */
export function getStackHistory(db: Database.Database, groupId: number): DayStatus[] {
  // Members of the stack (host_id, container_name pairs).
  const members = db.prepare(`
    SELECT host_id, container_name FROM service_group_members WHERE group_id = ?
  `).all(groupId) as { host_id: string; container_name: string }[];
  if (members.length === 0) return fillDays([]);

  // Merge raw snapshots + hourly rollups for the last 30 days, group by UTC day.
  // Raw status = 'running' counts as 1 up; rollup carries explicit up/total.
  const placeholders = members.map(() => '(?, ?)').join(',');
  const params: (string | number)[] = [];
  for (const m of members) { params.push(m.host_id, m.container_name); }

  const rows = db.prepare(`
    WITH pairs(host_id, container_name) AS (VALUES ${placeholders})
    SELECT day, SUM(up) AS up, SUM(total) AS total FROM (
      SELECT substr(s.collected_at, 1, 10) AS day,
             CASE WHEN s.status = 'running' THEN 1 ELSE 0 END AS up,
             1 AS total
      FROM container_snapshots s
      JOIN pairs p ON p.host_id = s.host_id AND p.container_name = s.container_name
      WHERE s.collected_at >= date('now', '-${HISTORY_DAYS} days')
      UNION ALL
      SELECT substr(r.bucket, 1, 10) AS day,
             COALESCE(r.status_running, 0) AS up,
             COALESCE(r.status_total, r.sample_count) AS total
      FROM container_rollups r
      JOIN pairs p ON p.host_id = r.host_id AND p.container_name = r.container_name
      WHERE r.bucket >= date('now', '-${HISTORY_DAYS} days')
    )
    GROUP BY day
  `).all(...params) as DayCountRow[];

  return fillDays(rows);
}

/** 30-day daily uptime for one HTTP endpoint. */
export function getEndpointHistory(db: Database.Database, endpointId: number): DayStatus[] {
  const rows = db.prepare(`
    SELECT day, SUM(up) AS up, SUM(total) AS total FROM (
      SELECT substr(checked_at, 1, 10) AS day,
             CASE WHEN is_up = 1 THEN 1 ELSE 0 END AS up,
             1 AS total
      FROM http_checks
      WHERE endpoint_id = ? AND checked_at >= date('now', '-${HISTORY_DAYS} days')
      UNION ALL
      SELECT substr(bucket, 1, 10) AS day,
             COALESCE(up_count, 0) AS up,
             COALESCE(total_count, sample_count) AS total
      FROM http_rollups
      WHERE endpoint_id = ? AND bucket >= date('now', '-${HISTORY_DAYS} days')
    )
    GROUP BY day
  `).all(endpointId, endpointId) as DayCountRow[];

  return fillDays(rows);
}

/** Resolved alerts in the last 30 days, newest first. Used as "Past incidents". */
export function getRecentIncidents(db: Database.Database, limit = 25): PublicIncident[] {
  const rows = db.prepare(`
    SELECT id, host_id, alert_type, target, message, triggered_at, resolved_at
    FROM alert_state
    WHERE resolved_at IS NOT NULL
      AND triggered_at >= datetime('now', '-${HISTORY_DAYS} days')
    ORDER BY resolved_at DESC
    LIMIT ?
  `).all(limit) as Omit<PublicIncident, 'durationMinutes'>[];

  return rows.map(r => {
    // Both timestamps are SQLite-formatted UTC; treat them as UTC explicitly.
    const triggered = Date.parse(r.triggered_at + 'Z');
    const resolved = Date.parse(r.resolved_at + 'Z');
    const durationMinutes = Number.isFinite(triggered) && Number.isFinite(resolved)
      ? Math.max(1, Math.round((resolved - triggered) / 60000))
      : 0;
    return { ...r, durationMinutes };
  });
}
