import { Link } from 'react-router-dom';
import { Card } from '@/components/Card';
import { timeAgo } from '@/lib/formatters';
import type { AttentionItem } from '@/hooks/useAttentionItems';

const KIND_CONFIG: Record<string, { icon: string; label: string }> = {
  alert: { icon: '\ud83d\udd14', label: 'Alert' },
  downtime: { icon: '\u23f8\ufe0f', label: 'Downtime' },
};

export function AttentionList({ attentionItems }: { attentionItems: AttentionItem[] }) {
  // When nothing needs attention, render nothing — the rest of the dashboard
  // (status row, host metrics) already communicates overall health, so a
  // dedicated "All systems operational" card is just filler that pushes real
  // content down the page.
  if (attentionItems.length === 0) return null;

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-secondary">Needs Attention</h3>
        <span className="text-xs text-muted">{attentionItems.length} item{attentionItems.length !== 1 ? 's' : ''}</span>
      </div>
      <div className="space-y-2">
        {attentionItems.map((item) => {
          const config = KIND_CONFIG[item.kind] ?? KIND_CONFIG.alert!;
          const borderColor = item.severity === 'critical' ? 'border-l-danger' : 'border-l-warning';
          const titleColor = item.severity === 'critical' ? 'text-danger' : 'text-warning';

          return (
            <Link key={`${item.kind}-${item.to}`} to={item.to}
              className={`block rounded-lg border-l-[3px] ${borderColor} bg-bg-secondary p-3 transition-colors hover:bg-surface-hover`}
            >
              <div className="flex items-start gap-2.5">
                <span className="mt-0.5 text-base leading-none">{config.icon}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={`text-sm font-medium ${titleColor}`}>{item.title}</span>
                    <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-xs font-medium uppercase ${
                      item.severity === 'critical' ? 'bg-danger/10 text-danger' : 'bg-warning/10 text-warning'
                    }`}>
                      {config.label}
                    </span>
                  </div>
                  {item.detail && (
                    <p className="mt-1 text-sm leading-relaxed text-secondary">{item.detail}</p>
                  )}
                  <div className="mt-1.5 flex items-center gap-2 text-xs text-muted">
                    <span>{item.meta}</span>
                    <span>&middot;</span>
                    <span className="capitalize">{item.kind}</span>
                    {item.time && (
                      <>
                        <span>&middot;</span>
                        <span>{timeAgo(item.time)}</span>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </Card>
  );
}
