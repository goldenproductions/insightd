import React, { Suspense } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import type { InsightExplanation } from '@/types/api';
import { CardSkeleton } from '@/components/Skeleton';
import { ReasonSummary } from './ReasonSummary';
import { ContributingTimeline } from './ContributingTimeline';
import { timeAgo } from '@/lib/formatters';
import { splitContainerEntityId } from '@/lib/containers';

const InsightChart = React.lazy(() => import('./InsightChart'));

export interface ExpandedBodyInsight {
  id: number;
  entity_type: string;
  entity_id: string;
  metric?: string | null;
  computed_at?: string | null;
  current_value?: number | null;
  baseline_value?: number | null;
}

function entityLink(insight: ExpandedBodyInsight): string {
  if (insight.entity_type === 'container') {
    const split = splitContainerEntityId(insight.entity_id);
    if (split) {
      return `/hosts/${encodeURIComponent(split.hostId)}/containers/${encodeURIComponent(split.containerName)}`;
    }
  }
  return `/hosts/${encodeURIComponent(insight.entity_id)}`;
}

function entityName(insight: ExpandedBodyInsight): string {
  if (insight.entity_type === 'container') {
    const split = splitContainerEntityId(insight.entity_id);
    if (split) return split.containerName;
  }
  return insight.entity_id;
}

function formatMetricValue(value: number | null | undefined, metric: string | null | undefined): string {
  if (value == null) return '-';
  if (metric?.includes('percent')) return `${Math.round(value * 10) / 10}%`;
  if (metric?.includes('mb') || metric?.includes('memory')) return `${Math.round(value)} MB`;
  if (metric?.includes('load')) return (Math.round(value * 100) / 100).toString();
  return (Math.round(value * 10) / 10).toString();
}

export function ExpandedBody({ insight }: { insight: ExpandedBodyInsight }) {
  const { data: explain, isError } = useQuery({
    queryKey: queryKeys.insightExplain(insight.id),
    queryFn: () => api<InsightExplanation>(`/insights/${insight.id}/explain`),
    staleTime: 60_000,
  });

  if (isError) return <FallbackStats insight={insight} />;
  if (!explain) return (
    <div className="border-t border-border px-4 py-3">
      <CardSkeleton lines={4} />
    </div>
  );

  return (
    <div className="space-y-4 border-t border-border px-4 py-3">
      <ReasonSummary summary={explain.summary} />
      <Suspense fallback={<CardSkeleton lines={3} />}>
        <InsightChart chart={explain.chart} />
      </Suspense>
      <ContributingTimeline events={explain.timeline} />
      <MetadataRow insight={insight} />
    </div>
  );
}

function MetadataRow({ insight }: { insight: ExpandedBodyInsight }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border pt-2 text-xs text-muted">
      <Link to={entityLink(insight)} className="text-info hover:underline">
        {entityName(insight)} <span className="text-muted">({insight.entity_type})</span>
      </Link>
      {insight.metric && <span>Metric: <span className="font-mono">{insight.metric}</span></span>}
      {insight.computed_at && <span>Computed {timeAgo(insight.computed_at)}</span>}
    </div>
  );
}

function FallbackStats({ insight }: { insight: ExpandedBodyInsight }) {
  return (
    <div className="border-t border-border px-4 py-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {insight.current_value != null && (
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-muted">Current</div>
            <div className="mt-0.5 text-lg font-bold text-fg">
              {formatMetricValue(insight.current_value, insight.metric)}
            </div>
          </div>
        )}
        {insight.baseline_value != null && (
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-muted">Baseline</div>
            <div className="mt-0.5 text-lg font-bold text-secondary">
              {formatMetricValue(insight.baseline_value, insight.metric)}
            </div>
          </div>
        )}
        <MetadataRow insight={insight} />
      </div>
    </div>
  );
}
