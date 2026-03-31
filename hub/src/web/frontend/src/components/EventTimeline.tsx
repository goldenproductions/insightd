import type { EventItem } from '@/types/api';
import { timeAgo } from '@/lib/formatters';

export function EventTimeline({ events }: { events: EventItem[] }) {
  if (events.length === 0) {
    return <p className="py-4 text-center text-xs" style={{ color: 'var(--text-muted)' }}>No events</p>;
  }

  return (
    <div className="space-y-2">
      {events.slice(0, 30).map((e, i) => (
        <div key={i} className="flex items-start gap-3">
          <span className="mt-1.5 text-xs" style={{ color: 'var(--text-muted)', minWidth: '4rem' }}>{timeAgo(e.time)}</span>
          <span className={`mt-1.5 h-2 w-2 flex-shrink-0 rounded-full ${e.good ? 'bg-emerald-500' : 'bg-red-500'}`} />
          <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>{e.message}</span>
        </div>
      ))}
    </div>
  );
}
