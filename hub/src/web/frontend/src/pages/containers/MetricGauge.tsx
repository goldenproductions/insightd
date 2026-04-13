export function MetricGauge({ label, current, avg, peak, unit, max, analogy }: {
  label: string; current: number | null; avg: number | null; peak: number | null; unit: string; max: number;
  analogy?: { emoji: string; label: string } | null;
}) {
  const pct = current != null ? Math.min(100, Math.round((current / max) * 100)) : 0;
  const avgPct = avg != null ? Math.min(100, Math.round((avg / max) * 100)) : null;
  const color = pct > 90 ? 'var(--color-danger)' : pct > 70 ? 'var(--color-warning)' : 'var(--color-success)';

  return (
    <div className="rounded-xl p-4 bg-surface border border-border">
      <div className="flex items-baseline justify-between">
        <span
          className="text-sm font-medium text-secondary"
          title="Rated against this container's own ~30-day history. 🧘 Napping = well below normal, 💪 Solid = normal range, 🔥 Burnout = unusually high."
        >
          {label}
        </span>
        <span className="text-2xl font-bold" style={{ color }}>
          {current != null ? `${current}${unit}` : '-'}
        </span>
      </div>
      {analogy && (
        <div
          className="mt-1 text-sm font-medium text-secondary"
          title="How this container compares to its own recent baseline."
        >
          <span className="mr-1" aria-hidden>{analogy.emoji}</span>
          {analogy.label}
        </div>
      )}
      <div className="relative mt-3 h-3 w-full rounded-full bg-border">
        <div className="h-3 rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: color }} />
        {avgPct != null && (
          <div className="absolute top-0 h-3 w-0.5 opacity-60" style={{ left: `${avgPct}%`, backgroundColor: 'var(--text-muted)' }}
            title={`avg ${avg}${unit}`} />
        )}
      </div>
      <div className="mt-2 flex gap-4 text-xs text-muted">
        <span>avg <span className="font-medium text-secondary">{avg != null ? `${avg}${unit}` : '-'}</span></span>
        <span>peak <span className="font-medium text-secondary">{peak != null ? `${peak}${unit}` : '-'}</span></span>
      </div>
    </div>
  );
}
