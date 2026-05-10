import { InsightCard } from './InsightCard';
import type { InsightRow } from '@/types/api';

export function InsightsTabPanel({
  insights,
  emptyMessage,
}: {
  insights: InsightRow[];
  emptyMessage?: string;
}) {
  if (insights.length === 0) {
    return (
      <p className="text-sm text-muted">{emptyMessage ?? 'No insights right now.'}</p>
    );
  }
  return (
    <div className="space-y-2">
      {insights.map(i => (
        <InsightCard key={i.id} insight={i} />
      ))}
    </div>
  );
}
