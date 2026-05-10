import type { ExplainTimelineMarker } from '@/types/api';
import { timeAgo } from '@/lib/formatters';

const KIND_DOT_COLOR: Record<ExplainTimelineMarker['kind'], string> = {
  log_burst:       'bg-warning',
  alert_fired:     'bg-danger',
  restart:         'bg-warning',
  threshold_cross: 'bg-info',
  event:           'bg-muted',
};

export function ContributingTimeline({ events }: { events: ExplainTimelineMarker[] }) {
  if (events.length === 0) {
    return null;
  }
  return (
    <div className="mt-4 border-t border-border pt-3">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">Contributing events</div>
      <ul className="mt-2 space-y-1.5">
        {events.map((e, i) => (
          <li key={i} className="flex items-start gap-2 text-xs">
            <span className={`mt-1 inline-block h-2 w-2 shrink-0 rounded-full ${KIND_DOT_COLOR[e.kind]}`} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium text-fg">{e.label}</span>
                <span className="text-muted" title={e.ts}>{timeAgo(e.ts)}</span>
              </div>
              {e.detail && <div className="truncate font-mono text-[11px] text-secondary">{e.detail}</div>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
