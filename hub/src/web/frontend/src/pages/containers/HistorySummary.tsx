import type { ContainerDetail } from '@/types/api';
import { Card } from '@/components/Card';
import { timeAgo } from '@/lib/formatters';

export function HistorySummary({ history }: { history: ContainerDetail['history'] }) {
  if (history.length === 0) return null;

  // Time range
  const oldest = history[0]!.collected_at;
  const newest = history[history.length - 1]!.collected_at;
  const rangeMs = new Date(newest + 'Z').getTime() - new Date(oldest + 'Z').getTime();
  const rangeLabel = rangeMs > 86400000 ? `${Math.round(rangeMs / 86400000)}d` : `${Math.round(rangeMs / 3600000)}h`;

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

  return (
    <Card title="History Summary">
      <div className="space-y-4">
        {/* Summary stats */}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          <span><span className="font-semibold text-fg">{history.length}</span> snapshots</span>
          <span><span className="font-semibold text-fg">{rangeLabel}</span> time range</span>
          <span><span className={`font-semibold ${statusChanges.length > 0 ? 'text-warning' : 'text-fg'}`}>{statusChanges.length}</span> status changes</span>
          <span><span className={`font-semibold ${restartEvents.length > 0 ? 'text-warning' : 'text-fg'}`}>{restartEvents.length}</span> restarts</span>
        </div>

        {/* Status strip — sampled to max 120 blocks */}
        <div>
          <div className="mb-1 text-xs text-muted">Status over time</div>
          <div className="flex gap-px overflow-hidden" style={{ height: 12 }}>
            {(() => {
              const maxBars = 120;
              const bucketSize = Math.max(1, Math.ceil(history.length / maxBars));
              const buckets: { status: string; time: string }[] = [];
              for (let i = 0; i < history.length; i += bucketSize) {
                const slice = history.slice(i, i + bucketSize);
                const anyDown = slice.some(s => s.status !== 'running');
                const mid = slice[Math.floor(slice.length / 2)]!;
                buckets.push({ status: anyDown ? 'down' : 'running', time: mid.collected_at });
              }
              return buckets.map((b, i) => (
                <div
                  key={i}
                  className={`flex-1 rounded-sm first:rounded-l last:rounded-r ${b.status === 'running' ? 'bg-success' : 'bg-danger'}`}
                  style={{ minWidth: 2 }}
                  title={`${b.status} — ${new Date(b.time + 'Z').toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`}
                />
              ));
            })()}
          </div>
          <div className="mt-1 flex justify-between text-[10px] text-muted">
            <span>{timeAgo(oldest)}</span>
            <span>{timeAgo(newest)}</span>
          </div>
        </div>

        {/* Key events */}
        {events.length > 0 ? (
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-secondary">
              Key Events
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
