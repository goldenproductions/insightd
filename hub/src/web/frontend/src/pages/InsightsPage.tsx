import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, apiAuth } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { useAuth } from '@/context/AuthContext';
import type { InsightRow, InsightFeedback } from '@/types/api';
import { Card } from '@/components/Card';
import { Badge } from '@/components/Badge';
import { PageTitle } from '@/components/PageTitle';
import { CardSkeleton } from '@/components/Skeleton';
import { timeAgo } from '@/lib/formatters';

const CATEGORY_LABELS: Record<string, string> = {
  performance: 'Performance',
  trend: 'Trend',
  availability: 'Availability',
  prediction: 'Prediction',
  health: 'Health Check',
};

const CATEGORY_ICONS: Record<string, string> = {
  performance: '\u26a1',
  trend: '\ud83d\udcc8',
  availability: '\u23f0',
  prediction: '\ud83d\udd2e',
  health: '\ud83e\ude7a',
};

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'red',
  warning: 'yellow',
  info: 'blue',
};

function entityLink(insight: InsightRow): string {
  if (insight.entity_type === 'container') {
    const parts = insight.entity_id.split('/');
    if (parts.length === 2) {
      return `/hosts/${encodeURIComponent(parts[0]!)}/containers/${encodeURIComponent(parts[1]!)}`;
    }
  }
  return `/hosts/${encodeURIComponent(insight.entity_id)}`;
}

function formatMetricValue(value: number | null, metric: string | null): string {
  if (value == null) return '-';
  if (metric?.includes('percent')) return `${Math.round(value * 10) / 10}%`;
  if (metric?.includes('mb') || metric?.includes('memory')) return `${Math.round(value)} MB`;
  if (metric?.includes('load')) return (Math.round(value * 100) / 100).toString();
  return (Math.round(value * 10) / 10).toString();
}

function entityName(insight: InsightRow): string {
  if (insight.entity_type === 'container') {
    const parts = insight.entity_id.split('/');
    return parts.length === 2 ? parts[1]! : insight.entity_id;
  }
  return insight.entity_id;
}

export function InsightsPage() {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const { data: insights } = useQuery({
    queryKey: queryKeys.insights(),
    queryFn: () => api<InsightRow[]>('/insights'),
    refetchInterval: 60_000,
  });
  const { data: allFeedback } = useQuery({
    queryKey: queryKeys.insightFeedback(),
    queryFn: () => api<InsightFeedback[]>('/insights/feedback'),
    staleTime: 60_000,
  });

  if (!insights) return (
    <div className="space-y-6">
      <PageTitle>Insights</PageTitle>
      <CardSkeleton lines={4} />
      <CardSkeleton lines={3} />
    </div>
  );

  const toggle = (id: number) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

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
        <InsightGroup label="Critical" insights={critical} expanded={expanded} onToggle={toggle} allFeedback={allFeedback} />
      )}
      {warning.length > 0 && (
        <InsightGroup label="Warning" insights={warning} expanded={expanded} onToggle={toggle} allFeedback={allFeedback} />
      )}
      {info.length > 0 && (
        <InsightGroup label="Info" insights={info} expanded={expanded} onToggle={toggle} allFeedback={allFeedback} />
      )}
    </div>
  );
}

function InsightGroup({ label, insights, expanded, onToggle, allFeedback }: {
  label: string;
  insights: InsightRow[];
  expanded: Set<number>;
  onToggle: (id: number) => void;
  allFeedback: InsightFeedback[] | undefined;
}) {
  return (
    <Card title={`${label} (${insights.length})`}>
      <div className="space-y-2">
        {insights.map(insight => {
          const fb = allFeedback?.find(f =>
            f.entity_type === insight.entity_type && f.entity_id === insight.entity_id &&
            f.category === insight.category && f.metric === insight.metric
          );
          return (
            <InsightCard key={insight.id} insight={insight} isExpanded={expanded.has(insight.id)} onToggle={() => onToggle(insight.id)} feedback={fb} />
          );
        })}
      </div>
    </Card>
  );
}

function InsightCard({ insight, isExpanded, onToggle, feedback }: {
  insight: InsightRow;
  isExpanded: boolean;
  onToggle: () => void;
  feedback: InsightFeedback | undefined;
}) {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  const icon = CATEGORY_ICONS[insight.category] || '\u2139\ufe0f';
  const severityColor = SEVERITY_COLORS[insight.severity] || 'blue';

  // Parse the persisted evidence JSON (schema v20+). Falls back to an empty
  // array for older rows without the column — still renders cleanly.
  const evidenceList: string[] = (() => {
    if (!insight.evidence) return [];
    try {
      const parsed = JSON.parse(insight.evidence);
      return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string') : [];
    } catch {
      return [];
    }
  })();
  const topEvidence = evidenceList[0];

  // Map category → (diagnoser, conclusion_tag) for Phase 4 calibration.
  // Only the 'health' category comes from the unified diagnoser today; the
  // others go through detector.ts with no signal structure, so they remain
  // view-only (calibration stays empty for those rows).
  const calibrationKey = insight.category === 'health' ? {
    diagnoser: 'unified',
    conclusion_tag: insight.title.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 64),
  } : null;

  const feedbackMutation = useMutation({
    mutationFn: (helpful: boolean) =>
      apiAuth('POST', '/insights/feedback', {
        entity_type: insight.entity_type,
        entity_id: insight.entity_id,
        category: insight.category,
        metric: insight.metric,
        helpful,
        ...(calibrationKey ?? {}),
      }, token),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.insightFeedback() }),
  });

  return (
    <div className="rounded-lg border border-border bg-bg-secondary">
      <button
        onClick={onToggle}
        className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-hover"
      >
        <span className="mt-0.5 text-base">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-fg">{insight.title}</span>
            <Badge text={CATEGORY_LABELS[insight.category] || insight.category} color={severityColor} />
          </div>
          {topEvidence && (
            <p className="mt-0.5 text-xs text-muted">{topEvidence}</p>
          )}
          <p className="mt-1 text-sm leading-relaxed text-secondary">{insight.message}</p>
        </div>
        <span className="mt-1 shrink-0 text-xs text-muted">{isExpanded ? '\u25b2' : '\u25bc'}</span>
      </button>

      {isExpanded && (
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
                <div className="text-xs font-medium uppercase tracking-wide text-muted">
                  {insight.category === 'prediction' ? 'Threshold (P90)' : insight.category === 'trend' ? 'Last Week' : 'Baseline (P95)'}
                </div>
                <div className="mt-0.5 text-lg font-bold text-secondary">
                  {formatMetricValue(insight.baseline_value, insight.metric)}
                </div>
              </div>
            )}
            {insight.current_value != null && insight.baseline_value != null && insight.baseline_value > 0 && (
              <div>
                <div className="text-xs font-medium uppercase tracking-wide text-muted">
                  {insight.category === 'availability' ? 'Target' : 'Deviation'}
                </div>
                <div className={`mt-0.5 text-lg font-bold ${insight.current_value > insight.baseline_value ? 'text-danger' : 'text-warning'}`}>
                  {insight.category === 'availability'
                    ? '99%'
                    : `${Math.round((insight.current_value / insight.baseline_value - 1) * 100)}%`
                  }
                </div>
              </div>
            )}
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-muted">Entity</div>
              <Link to={entityLink(insight)} className="mt-0.5 block text-sm font-medium text-info hover:underline">
                {entityName(insight)} <span className="text-xs text-muted">({insight.entity_type})</span>
              </Link>
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between">
            {insight.metric && (
              <div className="text-xs text-muted">
                Metric: <span className="font-mono">{insight.metric}</span> &middot; Computed {timeAgo(insight.computed_at)}
              </div>
            )}
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted mr-1">Helpful?</span>
              <button
                onClick={e => { e.stopPropagation(); feedbackMutation.mutate(true); }}
                className={`rounded px-2 py-1 text-sm transition-colors ${
                  feedback?.helpful === 1 ? 'bg-success/20 text-success' : 'text-muted hover:text-success hover:bg-success/10'
                }`}
                aria-label="Mark insight as helpful"
              >
                👍
              </button>
              <button
                onClick={e => { e.stopPropagation(); feedbackMutation.mutate(false); }}
                className={`rounded px-2 py-1 text-sm transition-colors ${
                  feedback?.helpful === 0 ? 'bg-danger/20 text-danger' : 'text-muted hover:text-danger hover:bg-danger/10'
                }`}
                aria-label="Mark insight as not helpful"
              >
                👎
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
