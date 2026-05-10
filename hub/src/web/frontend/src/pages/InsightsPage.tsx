import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import type { InsightRow } from '@/types/api';
import { Card } from '@/components/Card';
import { Badge } from '@/components/Badge';
import { PageTitle } from '@/components/PageTitle';
import { CardSkeleton } from '@/components/Skeleton';
import { ExpandedBody } from '@/components/insights/ExpandedBody';

// TODO(calibration): the per-insight "Helpful?" 👍/👎 UI was removed
// 2026-04-25 because nobody used it. Backend wiring is intact:
//   POST /api/insights/feedback        → handleInsightFeedback (handlers.ts)
//   confidence_calibration table       → Beta(2,2) posterior (calibration.ts)
//   FindingCard.feedback prop          → still optional, just unused
// To re-enable: pass `feedback` callbacks back into InsightCard rows below
// and to FindingCard instances on ContainerDetailPage.

const CATEGORY_LABELS: Record<string, string> = {
  performance: 'Performance',
  trend: 'Trend',
  availability: 'Availability',
  prediction: 'Prediction',
  health: 'Health Check',
  right_sizing: 'Right-sizing',
};

const CATEGORY_ICONS: Record<string, string> = {
  performance: '⚡',
  trend: '📈',
  availability: '⏰',
  prediction: '🔮',
  health: '🩺',
  right_sizing: '📐',
};

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'red',
  warning: 'yellow',
  info: 'blue',
};

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
  const icon = CATEGORY_ICONS[insight.category] || 'ℹ️';
  const severityColor = SEVERITY_COLORS[insight.severity] || 'blue';

  // Parse the persisted evidence JSON. Two on-disk shapes are tolerated:
  //   1. Legacy `string[]` — older rows or findings without log bursts.
  //   2. Rich `{ lines: string[], log_bursts: InsightLogBurst[] }` — emitted
  //      when the diagnoser attached `template_burst_events` references.
  const topEvidence = (() => {
    if (!insight.evidence) return null;
    try {
      const parsed = JSON.parse(insight.evidence);
      if (Array.isArray(parsed)) {
        return parsed.find((s): s is string => typeof s === 'string') ?? null;
      }
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.lines)) {
        return parsed.lines.find((s: unknown): s is string => typeof s === 'string') ?? null;
      }
      return null;
    } catch {
      return null;
    }
  })();

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
        <span className="mt-1 shrink-0 text-xs text-muted">{isExpanded ? '▲' : '▼'}</span>
      </button>

      {isExpanded && <ExpandedBody insight={insight} />}
    </div>
  );
}

