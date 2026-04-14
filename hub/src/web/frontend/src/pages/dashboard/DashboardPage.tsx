import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Link, useSearchParams } from 'react-router-dom';
import type { DashboardData, HealthData } from '@/types/api';
import { HealthBadge } from '@/components/HealthBadge';
import { useShowInternal } from '@/hooks/useShowInternal';
import { StatsGridSkeleton, CardSkeleton } from '@/components/Skeleton';
import { useFeedItems } from '@/hooks/useFeedItems';
import { useKeyboardShortcut } from '@/hooks/useKeyboardShortcut';
import { queryKeys } from '@/lib/queryKeys';
import { getAnalogy, type MetricType } from '@/lib/analogies';
import { StatusRow } from './StatusRow';
import { FeedCard } from './FeedCard';

export function DashboardPage() {
  const { showInternal } = useShowInternal();
  const si = showInternal ? '?showInternal=true' : '';
  const { data, error, refetch, isFetching, dataUpdatedAt } = useQuery({
    queryKey: queryKeys.dashboard(showInternal),
    queryFn: () => api<DashboardData>(`/dashboard${si}`),
    refetchInterval: 30_000,
    retry: 1,
  });
  const { data: health } = useQuery({
    queryKey: queryKeys.health(),
    queryFn: () => api<HealthData>('/health'),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const feedItems = useFeedItems(data);
  const acuteItems = feedItems.filter(i => i.kind !== 'insight');
  const insightItems = feedItems.filter(i => i.kind === 'insight');
  const concernCount = acuteItems.length;

  useKeyboardShortcut({
    keys: 'r',
    description: 'Refresh dashboard',
    scope: 'Dashboard',
    onTrigger: () => { refetch(); },
  });

  if (error && !data) return <DashboardError error={error} onRetry={() => refetch()} isRetrying={isFetching} />;

  if (!data) return (
    <div className="space-y-6">
      <div className="flex items-center gap-5 py-4">
        <div className="h-16 w-16 animate-pulse rounded-full bg-border" />
        <div className="flex-1 space-y-2">
          <div className="h-5 w-40 animate-pulse rounded bg-border" />
          <div className="h-4 w-56 animate-pulse rounded bg-border" />
        </div>
      </div>
      <StatsGridSkeleton count={5} />
      <CardSkeleton lines={4} />
    </div>
  );

  return (
    <div className="animate-fade-in">
      {/* Hero + StatusRow form a summary unit — tight 16px gap */}
      <HealthHero systemHealthScore={data.systemHealthScore} availability={data.availability} concernCount={concernCount} />
      <div className="mt-4">
        <StatusRow data={data} />
      </div>

      {/* Feed cards — 24px from summary unit, 16px between peer cards */}
      <div id="needs-attention" className="scroll-mt-4">
        <FeedCard className="mt-6" title="Needs Attention" items={acuteItems} />
      </div>
      <FeedCard
        className={acuteItems.length > 0 ? 'mt-4' : 'mt-6'}
        title="Insights"
        subtitle="Trends and predictions worth knowing"
        items={insightItems}
        viewAllHref="/insights"
      />

      {/* Peripheral footer */}
      <div className="mt-6">
        <DashboardFooter lastUpdatedAt={dataUpdatedAt} isFetching={isFetching} health={health} />
      </div>
    </div>
  );
}

function formatRelative(ms: number): string {
  if (ms < 5_000) return 'just now';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function DashboardFooter({ lastUpdatedAt, isFetching, health }: { lastUpdatedAt: number; isFetching: boolean; health: HealthData | undefined }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const relative = lastUpdatedAt > 0 ? formatRelative(now - lastUpdatedAt) : '—';

  return (
    <div className="flex items-center justify-end gap-2 pt-1 text-xs text-muted">
      <span
        className={`h-1.5 w-1.5 rounded-full ${isFetching ? 'bg-info animate-pulse' : 'bg-success/70'}`}
        aria-hidden="true"
      />
      <span>Updated {relative}</span>
      {health && (
        <>
          <span aria-hidden="true">&middot;</span>
          <span>Hub up {formatUptime(health.uptime)}</span>
        </>
      )}
    </div>
  );
}

function DashboardError({ error, onRetry, isRetrying }: { error: unknown; onRetry: () => void; isRetrying: boolean }) {
  const message = error instanceof Error ? error.message : 'Unknown error';
  return (
    <div className="animate-fade-in space-y-4">
      <div className="rounded-xl border border-danger/30 bg-danger/5 p-5">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 text-base leading-none" aria-hidden="true">⚠️</span>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-danger">Couldn't load the dashboard</h2>
            <p className="mt-1 text-sm text-secondary">
              The hub didn't respond. It might be restarting or temporarily unreachable.
            </p>
            <p className="mt-2 font-mono text-xs text-muted break-all">{message}</p>
            <button
              onClick={onRetry}
              disabled={isRetrying}
              className="mt-4 rounded-lg bg-info px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {isRetrying ? 'Retrying…' : 'Try again'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const RATING_COLORS: Record<string, string> = { normal: 'text-success', elevated: 'text-warning', high: 'text-orange-500', critical: 'text-danger' };
const FACTOR_LABELS: Record<string, string> = { cpu: 'CPU', memory: 'Memory', load: 'Load', online: 'Online', alerts: 'Alerts' };
const FACTOR_UNITS: Record<string, string> = { cpu: '%', memory: '%', load: '' };
const METRIC_FACTORS = new Set<MetricType>(['cpu', 'memory', 'load']);

function formatFactorValue(key: string, value: number | string): string {
  if (typeof value !== 'number') return String(value);
  const unit = FACTOR_UNITS[key] ?? '';
  return `${Math.round(value * 10) / 10}${unit}`;
}

function Chevron({ expanded, className = '' }: { expanded: boolean; className?: string }) {
  return (
    <svg
      className={`h-3 w-3 transition-transform duration-200 ${expanded ? 'rotate-180' : ''} ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function HealthHero({ systemHealthScore, availability, concernCount }: { systemHealthScore: DashboardData['systemHealthScore']; availability: DashboardData['availability']; concernCount: number }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const expanded = searchParams.get('hero') === 'expanded';
  const setExpanded = (next: boolean) => {
    setSearchParams(prev => {
      const p = new URLSearchParams(prev);
      if (next) p.set('hero', 'expanded');
      else p.delete('hero');
      return p;
    }, { replace: true });
  };
  const [showAllFactors, setShowAllFactors] = useState(false);

  const stateLabel = concernCount === 0
    ? 'All clear'
    : `${concernCount} item${concernCount === 1 ? '' : 's'} need${concernCount === 1 ? 's' : ''} attention`;

  const availText = availability.overallPercent != null
    ? `${availability.overallPercent}% availability over the last 24h`
    : 'Availability unavailable';
  const availColor = availability.overallPercent == null ? 'text-muted'
    : availability.overallPercent >= 99 ? 'text-success'
    : availability.overallPercent >= 95 ? 'text-warning'
    : 'text-danger';

  const scrollToNeedsAttention = () => {
    const el = document.getElementById('needs-attention');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="py-2">
      <div className="flex items-start gap-5">
        {systemHealthScore && <HealthBadge score={systemHealthScore.score} size="lg" />}
        <div className="min-w-0 flex-1">
          {concernCount > 0 ? (
            <button
              type="button"
              onClick={scrollToNeedsAttention}
              className="rounded text-left text-xl font-semibold text-warning transition-opacity hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-warning/40"
            >
              {stateLabel}
            </button>
          ) : (
            <div className="text-xl font-semibold text-fg">{stateLabel}</div>
          )}
          <div className={`mt-0.5 text-sm ${availColor}`}>
            {availText}
          </div>
          {systemHealthScore && (
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="mt-1 flex items-center gap-1 rounded text-xs text-muted transition-colors hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-border"
              aria-expanded={expanded}
              aria-controls="health-breakdown"
            >
              <span>{expanded ? 'Hide score breakdown' : 'Show health score breakdown'}</span>
              <Chevron expanded={expanded} />
            </button>
          )}
        </div>
      </div>

      {expanded && systemHealthScore?.hostBreakdown && (
        <div id="health-breakdown" className="mt-4 rounded-xl border border-border bg-surface p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-secondary">Health Breakdown by Host</h3>
          <div className="space-y-3">
            {systemHealthScore.hostBreakdown
              .sort((a, b) => a.score - b.score)
              .map(host => {
                const worstFactors = Object.entries(host.factors)
                  .filter(([, f]) => f.rating !== 'normal')
                  .sort(([, a], [, b]) => a.score - b.score);
                const visibleFactors = showAllFactors ? worstFactors : worstFactors.slice(0, 2);
                const hiddenCount = worstFactors.length - visibleFactors.length;
                return (
                  <Link key={host.hostId} to={`/hosts/${encodeURIComponent(host.hostId)}`}
                    className="flex items-center gap-3 rounded-lg px-3 py-2 hover-surface">
                    <HealthBadge score={host.score} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-fg">{host.hostId}</div>
                      {visibleFactors.length > 0 ? (
                        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
                          {visibleFactors.map(([key, f]) => {
                            const analogy = METRIC_FACTORS.has(key as MetricType) && typeof f.value === 'number'
                              ? getAnalogy(key as MetricType, f.value)
                              : null;
                            return (
                              <span key={key} className={`text-xs ${RATING_COLORS[f.rating] || 'text-muted'}`}>
                                {FACTOR_LABELS[key] || key}:{' '}
                                {analogy
                                  ? <>{analogy.emoji} {analogy.label} <span className="text-muted">({formatFactorValue(key, f.value)})</span></>
                                  : <>{formatFactorValue(key, f.value)}</>}
                              </span>
                            );
                          })}
                          {hiddenCount > 0 && <span className="text-xs text-muted">+{hiddenCount} more</span>}
                        </div>
                      ) : (
                        <span className="text-xs text-success">All factors normal</span>
                      )}
                    </div>
                    <span className="text-lg font-bold" style={{ color: host.score >= 90 ? 'var(--color-success)' : host.score >= 70 ? 'var(--color-warning)' : 'var(--color-danger)' }}>
                      {host.score}
                    </span>
                  </Link>
                );
              })}
          </div>
          {systemHealthScore.hostBreakdown.some(h => Object.values(h.factors).filter(f => f.rating !== 'normal').length > 2) && (
            <button
              onClick={e => { e.stopPropagation(); setShowAllFactors(!showAllFactors); }}
              className="mt-2 flex items-center gap-1 text-xs text-muted hover:text-fg"
            >
              <Chevron expanded={showAllFactors} />
              <span>{showAllFactors ? 'Show less' : 'Show all factors'}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
