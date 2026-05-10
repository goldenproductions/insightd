import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import type { InsightRow } from '@/types/api';
import { Card } from '@/components/Card';
import { PageTitle } from '@/components/PageTitle';
import { CardSkeleton } from '@/components/Skeleton';
import { InsightCard } from '@/components/insights/InsightCard';

// TODO(calibration): the per-insight "Helpful?" 👍/👎 UI was removed
// 2026-04-25 because nobody used it. Backend wiring is intact:
//   POST /api/insights/feedback        → handleInsightFeedback (handlers.ts)
//   confidence_calibration table       → Beta(2,2) posterior (calibration.ts)
//   FindingCard.feedback prop          → still optional, just unused
// To re-enable: pass `feedback` callbacks back into InsightCard rows below
// and to FindingCard instances on ContainerDetailPage.

export function InsightsPage() {
  const { data: insights } = useQuery({
    queryKey: queryKeys.insights(),
    queryFn: () => api<InsightRow[]>('/insights'),
    refetchInterval: 60_000,
  });

  if (!insights) return (
    <div className="space-y-6">
      <PageTitle>Insights</PageTitle>
      <CardSkeleton lines={4} />
      <CardSkeleton lines={3} />
    </div>
  );

  const critical = insights.filter(i => i.severity === 'critical');
  const warning = insights.filter(i => i.severity === 'warning');
  const info = insights.filter(i => i.severity === 'info');

  return (
    <div className="animate-fade-in space-y-6">
      <PageTitle>Insights</PageTitle>

      {insights.length === 0 && (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-border bg-surface px-4 py-8">
          <span className="h-2 w-2 rounded-full bg-success" />
          <span className="text-sm font-medium text-success">All clear — no insights right now</span>
        </div>
      )}

      {critical.length > 0 && (
        <InsightGroup label="Critical" insights={critical} />
      )}
      {warning.length > 0 && (
        <InsightGroup label="Warning" insights={warning} />
      )}
      {info.length > 0 && (
        <InsightGroup label="Info" insights={info} />
      )}
    </div>
  );
}

function InsightGroup({ label, insights }: {
  label: string;
  insights: InsightRow[];
}) {
  return (
    <Card title={`${label} (${insights.length})`}>
      <div className="space-y-2">
        {insights.map(insight => (
          <InsightCard key={insight.id} insight={insight} />
        ))}
      </div>
    </Card>
  );
}

