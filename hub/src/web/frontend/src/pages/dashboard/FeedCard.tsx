import { useCallback, useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card } from '@/components/Card';
import { LinkButton } from '@/components/FormField';
import { FeedRow } from '@/components/FeedRow';
import { api, apiAuth } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { useAuth } from '@/context/AuthContext';
import type { InsightFeedback, DashboardInsight } from '@/types/api';
import type { FeedItem } from '@/hooks/useFeedItems';

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
}

export function FeedCard({ title, subtitle, items, viewAllHref, className }: FeedCardProps) {
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

  if (visible.length === 0 && dismissedCount === 0) return null;

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
                <InsightActions insight={item.insight} onDismiss={() => dismiss(item)} />
              ) : undefined}
            />
          ))}
        </div>
      ) : (
        <p className="py-2 text-center text-xs text-muted">All insights dismissed for this session</p>
      )}
    </Card>
  );
}

function InsightActions({ insight, onDismiss }: { insight: DashboardInsight; onDismiss: () => void }) {
  const { token } = useAuth();
  const queryClient = useQueryClient();

  const { data: allFeedback } = useQuery({
    queryKey: queryKeys.insightFeedback(),
    queryFn: () => api<InsightFeedback[]>('/insights/feedback'),
    staleTime: 60_000,
  });

  const key = insightKey(insight);
  const existing = allFeedback?.find(f =>
    `${f.entity_type}:${f.entity_id}:${f.category}` === key
  );

  const mutation = useMutation({
    mutationFn: (helpful: boolean) =>
      apiAuth('POST', '/insights/feedback', {
        entity_type: insight.entity_type,
        entity_id: insight.entity_id,
        category: insight.category,
        metric: null,
        helpful,
      }, token),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.insightFeedback() }),
  });

  return (
    <div className="flex items-center justify-between border-t border-border-light px-3 py-1.5">
      <div className="flex items-center gap-1">
        <span className="text-xs text-muted mr-1">Helpful?</span>
        <button
          onClick={() => mutation.mutate(true)}
          className={`rounded px-1.5 py-0.5 text-xs transition-colors ${
            existing?.helpful === 1 ? 'bg-success/20 text-success' : 'text-muted hover:text-success hover:bg-success/10'
          }`}
          aria-label="Mark insight as helpful"
        >
          👍
        </button>
        <button
          onClick={() => mutation.mutate(false)}
          className={`rounded px-1.5 py-0.5 text-xs transition-colors ${
            existing?.helpful === 0 ? 'bg-danger/20 text-danger' : 'text-muted hover:text-danger hover:bg-danger/10'
          }`}
          aria-label="Mark insight as not helpful"
        >
          👎
        </button>
      </div>
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
