import { useMemo } from 'react';
import type { HostDetail, TimelineResponse } from '@/types/api';
import { StatusDot } from '@/components/StatusDot';
import { fmtUptime, timeAgo } from '@/lib/formatters';

interface Props {
  data: HostDetail;
  timeline: TimelineResponse | undefined;
}

interface SlotStats {
  pct: number | null;
  upHours: number;
  downHours: number;
  noDataHours: number;
}

function summarizeSlots(slots: ('up' | 'down' | 'completed' | 'none')[]): SlotStats {
  let up = 0, down = 0, none = 0;
  for (const s of slots) {
    if (s === 'up') up++;
    else if (s === 'down') down++;
    // Host-level slots are never 'completed' (host uptime tracks agent
    // reporting cadence, not container exit codes), but typed for parity.
    else if (s !== 'completed') none++;
  }
  const counted = up + down;
  return {
    pct: counted === 0 ? null : (up / counted) * 100,
    upHours: up,
    downHours: down,
    noDataHours: none,
  };
}

function fmtPct(pct: number | null): string {
  if (pct == null) return '—';
  // Mirror the design's "99.97%" / "100%" precision: drop trailing decimals
  // when they don't add information.
  if (pct >= 99.95) return pct >= 99.995 ? '100%' : pct.toFixed(2) + '%';
  if (pct >= 99) return pct.toFixed(2) + '%';
  return pct.toFixed(1) + '%';
}

function fmtIncidentSummary(downHours: number): string {
  if (downHours === 0) return 'no incidents';
  if (downHours === 1) return '1h downtime';
  return `${downHours}h downtime`;
}

export function HostUptimeHero({ data, timeline }: Props) {
  const hostSlots = timeline?.host?.slots;
  const stats = useMemo(() => {
    if (!hostSlots || hostSlots.length === 0) return null;
    const last24 = hostSlots.slice(-24);
    return {
      day: summarizeSlots(last24),
      week: summarizeSlots(hostSlots),
    };
  }, [hostSlots]);

  const isOnline = !!data.is_online;
  const uptimeSeconds = data.hostMetrics?.uptime_seconds ?? null;

  // Tone: emerald when online, amber when offline (agent not reporting)
  const tone = isOnline
    ? 'border-success/30 bg-gradient-to-br from-success/10 to-success/[0.03]'
    : 'border-warning/40 bg-gradient-to-br from-warning/15 to-warning/[0.04]';
  const labelTone = isOnline ? 'text-success' : 'text-warning';
  const statusLabel = isOnline ? 'Currently online' : 'Agent not reporting';
  const headline = isOnline
    ? (uptimeSeconds != null ? `Up for ${fmtUptime(uptimeSeconds)}` : 'Uptime unknown')
    : `Last seen ${timeAgo(data.last_seen)}`;

  return (
    <div className={`rounded-xl border p-4 ${tone}`}>
      <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-4">
        <div className="flex items-center gap-4">
          <StatusDot status={isOnline ? 'online' : 'offline'} size="lg" />
          <div>
            <div className={`text-[11px] font-semibold uppercase tracking-wider ${labelTone}`}>
              {statusLabel}
            </div>
            <div className="text-xl font-bold text-fg tabular-nums">{headline}</div>
            {!isOnline && (
              <div className="mt-0.5 text-xs text-muted">
                Metrics and container state below are the last values received — treat as stale.
              </div>
            )}
          </div>
        </div>

        {stats && (
          <div className="flex items-start gap-8 text-sm">
            <UptimeStat
              label="Last 24h"
              pct={stats.day.pct}
              sub={fmtIncidentSummary(stats.day.downHours)}
              isOnline={isOnline}
            />
            <UptimeStat
              label="Last 7 days"
              pct={stats.week.pct}
              sub={fmtIncidentSummary(stats.week.downHours)}
              isOnline={isOnline}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function UptimeStat({ label, pct, sub, isOnline }: { label: string; pct: number | null; sub: string; isOnline: boolean }) {
  const goodEnough = pct != null && pct >= 99;
  const valueClass = pct == null
    ? 'text-muted'
    : goodEnough && isOnline ? 'text-success'
    : pct >= 95 ? 'text-warning'
    : 'text-danger';
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className={`text-base font-bold tabular-nums ${valueClass}`}>{fmtPct(pct)} up</div>
      <div className="text-[10px] text-muted">{sub}</div>
    </div>
  );
}
