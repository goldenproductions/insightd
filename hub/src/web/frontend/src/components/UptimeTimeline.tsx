import type { TimelineEntry } from '@/types/api';

export function UptimeTimeline({ containers }: { containers: TimelineEntry[] }) {
  if (containers.length === 0) return null;

  return (
    <div className="space-y-1.5">
      {containers.map(c => (
        <div key={c.name} className="flex items-center gap-2">
          <span className="w-28 truncate text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>{c.name}</span>
          <div className="flex flex-1 gap-px">
            {c.slots.map((slot, i) => (
              <div
                key={i}
                className="h-3 flex-1 rounded-sm first:rounded-l last:rounded-r"
                style={{
                  backgroundColor: slot === 'up' ? 'var(--color-success)' : slot === 'down' ? 'var(--color-danger)' : 'var(--border)',
                  opacity: slot === 'none' ? 0.3 : 1,
                }}
                title={slot}
              />
            ))}
          </div>
          <span className="w-12 text-right text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
            {c.uptimePercent != null ? `${c.uptimePercent}%` : '-'}
          </span>
        </div>
      ))}
    </div>
  );
}
