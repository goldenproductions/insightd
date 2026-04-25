import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/Card';
import { LinkButton } from '@/components/FormField';
import { FeedRow } from '@/components/FeedRow';
import type { DashboardInsight } from '@/types/api';
import type { FeedItem } from '@/hooks/useFeedItems';

// TODO(calibration): per-insight 👍/👎 buttons removed 2026-04-25 — see
// the matching note in InsightsPage.tsx. Backend POST /api/insights/feedback
// is still wired; restore <InsightActions> here when re-enabling.

const DISMISSED_STORAGE_KEY = 'insightd-dismissed-insights';

function loadDismissed(): Set<string> {
  try {
    const raw = sessionStorage.getItem(DISMISSED_STORAGE_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function saveDismissed(dismissed: Set<string>): void {
  sessionStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify([...dismissed]));
}

function insightKey(insight: DashboardInsight): string {
  return `${insight.entity_type}:${insight.entity_id}:${insight.category}`;
}

interface FeedCardProps {
  title: string;
  subtitle?: string;
  items: FeedItem[];
  viewAllHref?: string;
  className?: string;
  /** Calm message shown when there are no items. Required so empty-state copy stays page-specific. */
  emptyMessage: string;
}

export function FeedCard({ title, subtitle, items, viewAllHref, className, emptyMessage }: FeedCardProps) {
  const [dismissed, setDismissed] = useState(loadDismissed);
  const [lastDismissed, setLastDismissed] = useState<FeedItem | null>(null);

  const dismiss = useCallback((item: FeedItem) => {
    if (!item.insight) return;
    setDismissed(prev => {
      const next = new Set(prev);
      next.add(insightKey(item.insight!));
      saveDismissed(next);
      return next;
    });
    setLastDismissed(item);
  }, []);

  const undoDismiss = useCallback(() => {
    if (!lastDismissed?.insight) return;
    const key = insightKey(lastDismissed.insight);
    setDismissed(prev => {
      const next = new Set(prev);
      next.delete(key);
      saveDismissed(next);
      return next;
    });
    setLastDismissed(null);
  }, [lastDismissed]);

  useEffect(() => {
    if (!lastDismissed) return;
    const t = setTimeout(() => setLastDismissed(null), 5000);
    return () => clearTimeout(t);
  }, [lastDismissed]);

  const visible = items.filter(item =>
    item.kind !== 'insight' || !item.insight || !dismissed.has(insightKey(item.insight))
  );
  const dismissedCount = items.filter(item =>
    item.kind === 'insight' && item.insight && dismissed.has(insightKey(item.insight))
  ).length;

  return (
    <Card className={className}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-secondary">
            {title}
            {dismissedCount > 0 && (
              <span className="ml-1 font-normal text-muted">({dismissedCount} dismissed)</span>
            )}
          </h3>
          {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="text-xs text-muted">{visible.length} item{visible.length !== 1 ? 's' : ''}</span>
          {viewAllHref && <LinkButton to={viewAllHref} variant="ghost" size="sm">View all</LinkButton>}
        </div>
      </div>
      {lastDismissed && (
        <div
          role="status"
          className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-border bg-bg-secondary px-3 py-2 text-xs animate-fade-in"
        >
          <span className="min-w-0 truncate text-secondary">
            Dismissed <span className="font-medium text-fg">{lastDismissed.title}</span>
          </span>
          <button
            onClick={undoDismiss}
            className="shrink-0 rounded px-2 py-0.5 font-medium text-info hover:bg-info/10"
          >
            Undo
          </button>
        </div>
      )}
      {visible.length > 0 ? (
        <div className="space-y-2">
          {visible.map(item => (
            <FeedRow
              key={item.id}
              icon={item.icon}
              title={item.title}
              pillLabel={item.pillLabel}
              severity={item.severity}
              detail={item.detail}
              meta={item.meta}
              time={item.time}
              to={item.to}
              footer={item.kind === 'insight' && item.insight ? (
                <DismissAction onDismiss={() => dismiss(item)} />
              ) : undefined}
            />
          ))}
        </div>
      ) : dismissedCount > 0 ? (
        <p className="py-2 text-center text-xs text-muted">All insights dismissed for this session</p>
      ) : (
        <p className="py-6 text-center text-sm text-muted">{emptyMessage}</p>
      )}
    </Card>
  );
}

function DismissAction({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="flex items-center justify-end border-t border-border-light px-3 py-1.5">
      <button
        onClick={onDismiss}
        className="rounded px-1.5 py-0.5 text-xs text-muted transition-colors hover:text-fg"
        aria-label="Dismiss insight"
      >
        Dismiss
      </button>
    </div>
  );
}
