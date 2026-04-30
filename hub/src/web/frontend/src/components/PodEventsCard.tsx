import type { PodEvent } from '@/types/api';
import { Card } from '@/components/Card';
import { timeAgo } from '@/lib/formatters';

interface Props {
  events: PodEvent[] | undefined;
}

function eventTone(type: string, reason: string): { dot: string; pill: string } {
  if (type === 'Warning') {
    if (/(?:Failed|BackOff|Unhealthy|Killing|FailedScheduling|FailedMount|FailedCreate)/i.test(reason)) {
      return { dot: 'bg-danger', pill: 'border-danger/40 text-danger bg-danger/5' };
    }
    return { dot: 'bg-warning', pill: 'border-warning/40 text-warning bg-warning/5' };
  }
  return { dot: 'bg-info/60', pill: 'border-info/30 text-info bg-info/5' };
}

export function PodEventsCard({ events }: Props) {
  if (!events || events.length === 0) return null;

  return (
    <Card title={<>Recent k8s events <span className="ml-1 text-xs font-normal text-muted">({events.length})</span></>}>
      <ul className="space-y-2">
        {events.map(ev => {
          const tone = eventTone(ev.type, ev.reason);
          return (
            <li key={ev.event_uid} className="flex items-start gap-3 text-sm">
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${tone.dot}`} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${tone.pill}`}>
                    {ev.reason}
                  </span>
                  <span className="text-[11px] font-mono text-muted">
                    {ev.involved_kind}/{ev.involved_name}
                  </span>
                  {ev.count > 1 && (
                    <span className="text-[11px] text-muted" title={`Seen ${ev.count} times`}>
                      ×{ev.count}
                    </span>
                  )}
                  <span className="ml-auto text-[11px] text-muted" title={ev.last_seen_at}>
                    {timeAgo(ev.last_seen_at)}
                  </span>
                </div>
                {ev.message && (
                  <div className="mt-0.5 break-words text-xs text-secondary">
                    {ev.message}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-[11px] text-muted">
        Includes events for this pod, its parent workload, and (for Deployment-owned pods) the underlying ReplicaSet.
      </p>
    </Card>
  );
}
