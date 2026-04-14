import type { ContainerDetail } from '@/types/api';
import { Card } from '@/components/Card';
import { UptimeTimeline } from '@/components/UptimeTimeline';
import { timeAgo } from '@/lib/formatters';

function parseTs(s: string): number {
  return new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z').getTime();
}

export function HistorySummary({ history }: { history: ContainerDetail['history'] }) {
  if (history.length === 0) return null;

  // Time range — snapshots come as SQLite timestamps (no trailing Z) or ISO.
  const oldestTs = parseTs(history[0]!.collected_at);
  const newestTs = parseTs(history[history.length - 1]!.collected_at);
  const rangeMs = Math.max(1, newestTs - oldestTs);
  const days = rangeMs / 86400000;
  const rangeLabel = rangeMs > 86400000 ? `${Math.round(days)}d` : `${Math.round(rangeMs / 3600000)}h`;

  // Status changes
  const statusChanges: { time: string; from: string; to: string }[] = [];
  for (let i = 1; i < history.length; i++) {
    if (history[i]!.status !== history[i - 1]!.status) {
      statusChanges.push({ time: history[i]!.collected_at, from: history[i - 1]!.status, to: history[i]!.status });
    }
  }

  // Restart bumps
  const restartEvents: { time: string; delta: number }[] = [];
  for (let i = 1; i < history.length; i++) {
    const diff = history[i]!.restart_count - history[i - 1]!.restart_count;
    if (diff > 0) {
      restartEvents.push({ time: history[i]!.collected_at, delta: diff });
    }
  }

  // Combine events sorted newest first
  const events = [
    ...statusChanges.map(e => ({
      time: e.time,
      good: e.to === 'running',
      message: e.to === 'running' ? `Started (was ${e.from})` : `Stopped (${e.to})`,
    })),
    ...restartEvents.map(e => ({
      time: e.time,
      good: false,
      message: `Restarted${e.delta > 1 ? ` (${e.delta}x)` : ''}`,
    })),
  ].sort((a, b) => b.time.localeCompare(a.time));

  // Bucket snapshots into 'up'/'down'/'none' slots for the availability bar.
  // Aim for one slot per hour, clamped to [24, 168] so day labels always fit.
  const targetSlots = Math.min(168, Math.max(24, Math.ceil(rangeMs / 3600000)));
  const bucketMs = rangeMs / targetSlots;
  const slots: ('up' | 'down' | 'none')[] = [];
  let snapIdx = 0;
  for (let i = 0; i < targetSlots; i++) {
    const bucketStart = oldestTs + i * bucketMs;
    const bucketEnd = bucketStart + bucketMs;
    let anyDown = false;
    let any = false;
    while (snapIdx < history.length) {
      const t = parseTs(history[snapIdx]!.collected_at);
      if (t >= bucketEnd) break;
      if (t >= bucketStart) {
        any = true;
        if (history[snapIdx]!.status !== 'running') anyDown = true;
      }
      snapIdx++;
    }
    slots.push(!any ? 'none' : anyDown ? 'down' : 'up');
  }

  const runningSnaps = history.filter(h => h.status === 'running').length;
  const uptimePercent = Math.round((runningSnaps / history.length) * 1000) / 10;

  return (
    <Card title="History summary">
      <div className="space-y-4">
        {/* Summary stats */}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          <span><span className="font-semibold text-fg">{history.length}</span> snapshots</span>
          <span><span className="font-semibold text-fg">{rangeLabel}</span> time range</span>
          <span><span className={`font-semibold ${statusChanges.length > 0 ? 'text-warning' : 'text-fg'}`}>{statusChanges.length}</span> status changes</span>
          <span><span className={`font-semibold ${restartEvents.length > 0 ? 'text-warning' : 'text-fg'}`}>{restartEvents.length}</span> restarts</span>
        </div>

        {/* Status bar — reuses the same component as Process availability so the
            look and hover tooltip stay consistent across the detail page. */}
        <div>
          <div className="mb-1 text-xs text-muted">Status over time</div>
          <UptimeTimeline
            containers={[{ name: 'Status', slots, uptimePercent }]}
            startMs={oldestTs}
            days={days}
          />
          <div className="mt-1 flex justify-between text-[10px] text-muted">
            <span>{timeAgo(history[0]!.collected_at)}</span>
            <span>{timeAgo(history[history.length - 1]!.collected_at)}</span>
          </div>
        </div>

        {/* Key events */}
        {events.length > 0 ? (
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-secondary">
              Key events
            </div>
            <div className="space-y-1.5">
              {events.slice(0, 20).map((e, i) => (
                <div key={i} className="flex items-center gap-3 text-sm">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${e.good ? 'bg-success' : 'bg-danger'}`} />
                  <span className="text-xs text-muted" style={{ minWidth: '4rem' }}>{timeAgo(e.time)}</span>
                  <span className="text-secondary">{e.message}</span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted">No status changes or restarts in this period.</p>
        )}
      </div>
    </Card>
  );
}
