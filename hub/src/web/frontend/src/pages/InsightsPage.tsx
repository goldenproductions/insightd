import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import type { InsightRow, InsightLogBurst } from '@/types/api';
import { Card } from '@/components/Card';
import { Badge } from '@/components/Badge';
import { PageTitle } from '@/components/PageTitle';
import { CardSkeleton } from '@/components/Skeleton';
import { timeAgo } from '@/lib/formatters';
import { splitContainerEntityId } from '@/lib/containers';

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
  performance: '\u26a1',
  trend: '\ud83d\udcc8',
  availability: '\u23f0',
  prediction: '\ud83d\udd2e',
  health: '\ud83e\ude7a',
  right_sizing: '\ud83d\udcd0',
};

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'red',
  warning: 'yellow',
  info: 'blue',
};

function entityLink(insight: InsightRow): string {
  if (insight.entity_type === 'container') {
    const split = splitContainerEntityId(insight.entity_id);
    if (split) {
      return `/hosts/${encodeURIComponent(split.hostId)}/containers/${encodeURIComponent(split.containerName)}`;
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
    const split = splitContainerEntityId(insight.entity_id);
    if (split) return split.containerName;
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

  // Parse the persisted evidence JSON. Two on-disk shapes are tolerated:
  //   1. Legacy `string[]` — older rows or findings without log bursts.
  //   2. Rich `{ lines: string[], log_bursts: InsightLogBurst[] }` — emitted
  //      when the diagnoser attached `template_burst_events` references.
  const { evidenceList, logBursts } = (() => {
    if (!insight.evidence) return { evidenceList: [] as string[], logBursts: [] as InsightLogBurst[] };
    try {
      const parsed = JSON.parse(insight.evidence);
      if (Array.isArray(parsed)) {
        return {
          evidenceList: parsed.filter((s): s is string => typeof s === 'string'),
          logBursts: [] as InsightLogBurst[],
        };
      }
      if (parsed && typeof parsed === 'object') {
        const lines = Array.isArray(parsed.lines)
          ? parsed.lines.filter((s: unknown): s is string => typeof s === 'string')
          : [];
        const bursts = Array.isArray(parsed.log_bursts) ? parsed.log_bursts as InsightLogBurst[] : [];
        return { evidenceList: lines, logBursts: bursts };
      }
      return { evidenceList: [], logBursts: [] };
    } catch {
      return { evidenceList: [] as string[], logBursts: [] as InsightLogBurst[] };
    }
  })();
  const topEvidence = evidenceList[0];

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
          {logBursts.length > 0 && (
            <CoOccurringLogs bursts={logBursts} />
          )}
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

function formatIntensity(n: number): string {
  if (n >= 100) return `${Math.round(n)}×`;
  if (n >= 10) return `${n.toFixed(0)}×`;
  return `${n.toFixed(1)}×`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

// Tag labels/colors mirror LogPatternsList so the spike chip on the drawer
// card and the row in this subsection use the same vocabulary. Duplicated
// rather than shared because the two surfaces have slightly different
// shapes and a shared chip component would be overkill.
const BURST_TAG_LABELS: Record<string, string> = {
  oom: 'Out of memory', panic: 'Panic', segfault: 'Segfault', fatal: 'Fatal',
  conn_refused: 'Conn refused', conn_reset: 'Conn reset', conn_timeout: 'Conn timeout',
  dns_fail: 'DNS failure', permission: 'Permission', disk_full: 'Disk full',
  too_many_files: 'Too many files', db_locked: 'DB locked',
  http_401: 'HTTP 401', http_403: 'HTTP 403', http_404: 'HTTP 404',
  http_502: 'HTTP 502', http_503: 'HTTP 503',
};

const BURST_TAG_COLORS: Record<string, string> = {
  oom: 'red', panic: 'red', segfault: 'red', fatal: 'red',
  conn_refused: 'yellow', conn_reset: 'yellow', conn_timeout: 'yellow',
  dns_fail: 'yellow', disk_full: 'red', db_locked: 'yellow',
  http_502: 'red', http_503: 'red',
};

function CoOccurringLogs({ bursts }: { bursts: InsightLogBurst[] }) {
  return (
    <div className="mt-4 border-t border-border pt-3">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">
        Co-occurring logs
      </div>
      <ul className="mt-2 space-y-1.5">
        {bursts.map((b) => (
          <li
            key={b.id}
            className="rounded border border-border/50 bg-bg p-2 text-xs"
          >
            <div className="flex items-start justify-between gap-3">
              <code className="flex-1 break-words font-mono text-[11px] text-fg">
                {truncate(b.template, 200)}
              </code>
              <div className="flex shrink-0 items-center gap-1">
                {b.semantic_tag && (
                  <Badge
                    text={BURST_TAG_LABELS[b.semantic_tag] ?? b.semantic_tag}
                    color={BURST_TAG_COLORS[b.semantic_tag] ?? 'gray'}
                  />
                )}
                <span className="text-muted tabular-nums" title={`Batch fired ${b.batch_count} time(s)`}>
                  &times;{b.batch_count}
                </span>
              </div>
            </div>
            <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-muted">
              <span title={b.ts}>{timeAgo(b.ts)}</span>
              <span className="tabular-nums" title={`${formatIntensity(b.intensity)} historical baseline rate`}>
                {formatIntensity(b.intensity)} baseline
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
