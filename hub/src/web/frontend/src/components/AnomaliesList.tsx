import { useState } from 'react';
import type { RollupAnomaly } from '@/types/api';
import { Card } from '@/components/Card';
import { timeAgo } from '@/lib/formatters';

interface Props {
  anomalies?: RollupAnomaly[];
  /** 'container' drops the metric-host prefix; 'host' keeps it. */
  scope: 'container' | 'host';
}

const METRIC_LABELS: Record<string, string> = {
  cpu_max: 'CPU peak',
  mem_max: 'Memory peak',
  mem_used_max: 'Memory used (peak)',
};

function formatMetric(metric: string): string {
  return METRIC_LABELS[metric] ?? metric;
}

function formatValue(metric: string, value: number): string {
  if (metric.includes('cpu')) return `${Math.round(value * 10) / 10}%`;
  if (metric.includes('mem')) return `${Math.round(value)} MB`;
  return value.toString();
}

function severityOf(z: number): 'critical' | 'warning' | 'info' {
  if (z >= 10) return 'critical';
  if (z >= 5) return 'warning';
  return 'info';
}

const BADGE: Record<'critical' | 'warning' | 'info', string> = {
  critical: 'bg-danger/10 text-danger',
  warning: 'bg-warning/10 text-warning',
  info: 'bg-info/10 text-info',
};

/**
 * Historical S-H-ESD anomalies for this entity. Rendered as a collapsible
 * Card so it doesn't eat vertical space on the detail page when there's
 * nothing interesting.
 */
export function AnomaliesList({ anomalies, scope }: Props) {
  const [expanded, setExpanded] = useState(false);
  if (!anomalies || anomalies.length === 0) return null;

  const summary = `${anomalies.length} historical spike${anomalies.length === 1 ? '' : 's'} detected`;

  return (
    <Card
      title="Historical anomalies"
      actions={
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-xs text-muted hover:text-fg transition-colors"
        >
          {expanded ? 'Hide' : 'Show'}
        </button>
      }
    >
      <p className="text-xs text-muted">{summary} by S-H-ESD over the last 14 days of hourly rollups.</p>
      {expanded && (
        <ul className="mt-3 space-y-2">
          {anomalies.map((a, i) => {
            const sev = severityOf(a.robust_z);
            return (
              <li
                key={i}
                className="flex items-center justify-between gap-3 rounded border border-border/50 bg-bg-secondary/50 px-3 py-2 text-xs"
              >
                <div className="flex items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase ${BADGE[sev]}`}>
                    z = {Math.round(a.robust_z * 10) / 10}
                  </span>
                  <span className="font-medium text-fg">{formatMetric(a.metric)}</span>
                  <span className="text-muted">peaked at {formatValue(a.metric, a.value)}</span>
                </div>
                <span className="text-muted tabular-nums" title={a.detected_at}>
                  {scope === 'host' ? 'host' : 'container'} · {timeAgo(a.detected_at)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
