import { Link } from 'react-router-dom';
import { Card } from '@/components/Card';
import { timeAgo } from '@/lib/formatters';
import type { AttentionItem } from '@/hooks/useAttentionItems';

export function AttentionList({ attentionItems }: { attentionItems: AttentionItem[] }) {
  if (attentionItems.length === 0) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-xl px-4 py-3 bg-surface border border-border">
        <span className="h-2 w-2 rounded-full bg-success" />
        <span className="text-sm font-medium text-success">All systems operational</span>
      </div>
    );
  }

  return (
    <Card title="Needs Attention">
      <div className="space-y-1">
        {attentionItems.map((item, i) => (
          <Link key={i} to={item.to}
            className="flex items-center gap-3 rounded-lg px-3 py-2 -mx-1 hover-surface"
          >
            <span className={`h-2 w-2 shrink-0 rounded-full ${item.severity === 'critical' ? 'bg-danger' : 'bg-warning'}`} />
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${item.severity === 'critical' ? 'bg-danger/10 text-danger' : 'bg-warning/10 text-warning'}`}>
              {item.kind}
            </span>
            <span className="flex-1 truncate text-sm font-medium text-fg">
              {item.title}
            </span>
            <span className="hidden truncate text-xs text-secondary sm:block" style={{ maxWidth: '12rem' }}>
              {item.detail}
            </span>
            <span className="shrink-0 text-xs text-muted">
              {item.meta}
            </span>
            {item.time && (
              <span className="shrink-0 text-xs text-muted">
                {timeAgo(item.time)}
              </span>
            )}
          </Link>
        ))}
      </div>
    </Card>
  );
}
