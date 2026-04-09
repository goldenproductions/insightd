import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import type { InsightRow } from '@/types/api';
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
};

const CATEGORY_ICONS: Record<string, string> = {
  performance: '\u26a1',
  trend: '\ud83d\udcc8',
  availability: '\u23f0',
  prediction: '\ud83d\udd2e',
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
        <InsightGroup label="Critical" insights={critical} expanded={expanded} onToggle={toggle} />
      )}
      {warning.length > 0 && (
        <InsightGroup label="Warning" insights={warning} expanded={expanded} onToggle={toggle} />
      )}
      {info.length > 0 && (
        <InsightGroup label="Info" insights={info} expanded={expanded} onToggle={toggle} />
      )}
    </div>
  );
}

function InsightGroup({ label, insights, expanded, onToggle }: {
  label: string;
  insights: InsightRow[];
  expanded: Set<number>;
  onToggle: (id: number) => void;
}) {
  return (
    <Card title={`${label} (${insights.length})`}>
      <div className="space-y-2">
        {insights.map(insight => (
          <InsightCard key={insight.id} insight={insight} isExpanded={expanded.has(insight.id)} onToggle={() => onToggle(insight.id)} />
        ))}
      </div>
    </Card>
  );
}

function InsightCard({ insight, isExpanded, onToggle }: {
  insight: InsightRow;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const icon = CATEGORY_ICONS[insight.category] || '\u2139\ufe0f';
  const severityColor = SEVERITY_COLORS[insight.severity] || 'blue';

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
          {insight.metric && (
            <div className="mt-3 text-xs text-muted">
              Metric: <span className="font-mono">{insight.metric}</span> &middot; Computed {timeAgo(insight.computed_at)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
