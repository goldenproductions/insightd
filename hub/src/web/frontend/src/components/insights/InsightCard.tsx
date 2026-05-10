import { useState } from 'react';
import { Badge } from '@/components/Badge';
import type { InsightRow } from '@/types/api';
import { ExpandedBody } from './ExpandedBody';

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

function parseTopEvidence(evidence: string | null | undefined): string | null {
  if (!evidence) return null;
  try {
    const parsed = JSON.parse(evidence);
    if (Array.isArray(parsed)) {
      return parsed.find((s): s is string => typeof s === 'string') ?? null;
    }
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.lines)) {
      return parsed.lines.find((s: unknown): s is string => typeof s === 'string') ?? null;
    }
  } catch { /* ignore */ }
  return null;
}

export function InsightCard({ insight }: { insight: InsightRow }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const icon = CATEGORY_ICONS[insight.category] || 'ℹ️';
  const severityColor = SEVERITY_COLORS[insight.severity] || 'blue';
  const topEvidence = parseTopEvidence(insight.evidence);

  return (
    <div className="rounded-lg border border-border bg-bg-secondary">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
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
