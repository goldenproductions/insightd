import { Link } from 'react-router-dom';
import type { TimelineEntry } from '@/types/api';

export function UptimeTimeline({ containers, hostId, days = 7 }: { containers: TimelineEntry[]; hostId?: string; days?: number }) {
  if (containers.length === 0) return null;

  const now = Date.now();
  const startMs = now - days * 86400000;

  function slotTitle(slot: string, index: number): string {
    const slotStart = new Date(startMs + index * 3600000);
    const slotEnd = new Date(startMs + (index + 1) * 3600000);
    const fmt = (d: Date) => d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return `${slot} \u2014 ${fmt(slotStart)} to ${fmt(slotEnd)}`;
  }

  return (
    <div className="space-y-1.5">
      {containers.map(c => {
        const row = (
          <div className={`flex items-center gap-2${hostId ? ' cursor-pointer rounded-lg px-1 -mx-1 hover-surface' : ''}`}
          >
            <span className="w-28 truncate text-xs font-medium text-secondary">{c.name}</span>
            <div className="flex flex-1 gap-px">
              {c.slots.map((slot, i) => (
                <div
                  key={i}
                  className={`h-3 flex-1 rounded-sm first:rounded-l last:rounded-r ${slot === 'up' ? 'bg-success' : slot === 'down' ? 'bg-danger' : 'bg-border'} ${slot === 'none' ? 'opacity-30' : ''}`}
                  title={slotTitle(slot, i)}
                />
              ))}
            </div>
            <span className="w-12 text-right text-xs font-medium text-muted">
              {c.uptimePercent != null ? `${c.uptimePercent}%` : '-'}
            </span>
          </div>
        );

        if (hostId) {
          return (
            <Link key={c.name} to={`/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(c.name)}`} className="block">
              {row}
            </Link>
          );
        }
        return <div key={c.name}>{row}</div>;
      })}
    </div>
  );
}
