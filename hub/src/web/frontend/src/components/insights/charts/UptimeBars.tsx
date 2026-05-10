import type { ExplainChart } from '@/types/api';

export function UptimeBars({ chart }: { chart: ExplainChart }) {
  const intervals = chart.uptime ?? [];
  if (intervals.length === 0) {
    return <div className="text-xs text-muted">No uptime data for this window.</div>;
  }
  const first = intervals[0]!;
  const last = intervals[intervals.length - 1]!;
  const startMs = new Date(first.from.replace(' ', 'T') + 'Z').getTime();
  const endMs   = new Date(last.to.replace(' ', 'T') + 'Z').getTime();
  const span = Math.max(1, endMs - startMs);

  return (
    <div className="space-y-2">
      <div className="flex h-6 w-full overflow-hidden rounded">
        {intervals.map((iv, i) => {
          const a = new Date(iv.from.replace(' ', 'T') + 'Z').getTime();
          const b = new Date(iv.to.replace(' ', 'T') + 'Z').getTime();
          const widthPct = ((b - a) / span) * 100;
          return (
            <div
              key={i}
              title={`${iv.up ? 'Up' : 'Down'}: ${iv.from} → ${iv.to}`}
              className={iv.up ? 'bg-success' : 'bg-danger'}
              style={{ width: `${widthPct}%` }}
            />
          );
        })}
      </div>
      <div className="flex justify-between text-[10px] text-muted">
        <span>{first.from}</span>
        <span>{last.to}</span>
      </div>
    </div>
  );
}
