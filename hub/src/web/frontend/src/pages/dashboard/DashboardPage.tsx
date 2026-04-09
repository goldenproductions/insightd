import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Link } from 'react-router-dom';
import type { DashboardData, Rankings } from '@/types/api';
import { Card } from '@/components/Card';
import { RankingList } from '@/components/RankingList';
import { HealthBadge } from '@/components/HealthBadge';
import { useShowInternal } from '@/hooks/useShowInternal';
import { StatsGridSkeleton, CardSkeleton } from '@/components/Skeleton';
import { InsightsFeed } from '@/components/InsightsFeed';
import { useAttentionItems } from '@/hooks/useAttentionItems';
import { getAnalogy } from '@/lib/analogies';
import { queryKeys } from '@/lib/queryKeys';
import { StatusRow } from './StatusRow';
import { AttentionList } from './AttentionList';

export function DashboardPage() {
  const { showInternal } = useShowInternal();
  const si = showInternal ? '?showInternal=true' : '';
  const { data } = useQuery({ queryKey: queryKeys.dashboard(showInternal), queryFn: () => api<DashboardData>(`/dashboard${si}`), refetchInterval: 30_000 });
  const { data: rankings } = useQuery({ queryKey: queryKeys.rankings(), queryFn: () => api<Rankings>('/rankings?limit=5'), refetchInterval: 30_000 });

  const attentionItems = useAttentionItems(data);

  if (!data) return (
    <div className="space-y-6">
      <div className="flex items-center justify-center gap-12 py-4">
        <div className="flex flex-col items-center gap-2">
          <div className="h-16 w-16 animate-pulse rounded-full bg-border" />
          <div className="h-3 w-20 animate-pulse rounded bg-border" />
        </div>
        <div className="flex flex-col items-center gap-2">
          <div className="h-10 w-16 animate-pulse rounded bg-border" />
          <div className="h-3 w-24 animate-pulse rounded bg-border" />
        </div>
      </div>
      <StatsGridSkeleton count={5} />
      <CardSkeleton lines={4} />
    </div>
  );

  return (
    <div className="animate-fade-in space-y-6">
      {/* Hero */}
      <HealthHero systemHealthScore={data.systemHealthScore} availability={data.availability} />

      <StatusRow data={data} />

      <AttentionList attentionItems={attentionItems} />

      {data.topInsights && <InsightsFeed insights={data.topInsights} />}

      {/* Stacks */}
      {data.groups && data.groups.length > 0 && (
        <Card title="Stacks">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.groups.map(g => (
              <Link key={g.id} to={`/stacks/${g.id}`} className="block rounded-lg p-3 hover-surface card-interactive border border-border" style={{ borderLeft: `3px solid ${g.color || 'var(--color-info)'}` }}
              >
                <div className="font-medium text-sm text-fg">{g.icon && <span className="mr-1">{g.icon}</span>}{g.name}</div>
                <div className="text-xs mt-1 text-muted">
                  <span className={g.running_count === g.member_count ? 'text-success' : 'text-danger'}>{g.running_count}/{g.member_count}</span> running
                </div>
              </Link>
            ))}
          </div>
        </Card>
      )}

      {/* Rankings */}
      {rankings && (
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Top CPU">
            <RankingList items={rankings.byCpu} valueKey="cpu_percent" formatFn={v => v.toFixed(1) + '%'} analogyFn={v => getAnalogy('cpu', v)} />
          </Card>
          <Card title="Top Memory">
            <RankingList items={rankings.byMemory} valueKey="memory_mb" formatFn={v => Math.round(v) + ' MB'} analogyFn={v => getAnalogy('memory', v, 1024)} />
          </Card>
        </div>
      )}
    </div>
  );
}

const RATING_COLORS: Record<string, string> = { normal: 'text-success', elevated: 'text-warning', high: 'text-orange-500', critical: 'text-danger' };
const RATING_EMOJI: Record<string, string> = { normal: '✅', elevated: '⚠️', high: '🔶', critical: '🔴' };
const FACTOR_LABELS: Record<string, string> = { cpu: 'CPU', memory: 'Memory', load: 'Load', online: 'Online', alerts: 'Alerts' };
const FACTOR_UNITS: Record<string, string> = { cpu: '%', memory: '%', load: '' };

function formatFactorValue(key: string, value: number | string): string {
  if (typeof value !== 'number') return String(value);
  const unit = FACTOR_UNITS[key] ?? '';
  return `${Math.round(value * 10) / 10}${unit}`;
}

function HealthHero({ systemHealthScore, availability }: { systemHealthScore: DashboardData['systemHealthScore']; availability: DashboardData['availability'] }) {
  const [expanded, setExpanded] = useState(false);
  const [showAllFactors, setShowAllFactors] = useState(false);

  return (
    <div className="py-4">
      <div className="flex items-center justify-center gap-12">
        {systemHealthScore && (
          <button onClick={() => setExpanded(!expanded)} className="flex flex-col items-center gap-1 cursor-pointer hover:opacity-80 transition-opacity">
            <HealthBadge score={systemHealthScore.score} size="lg" />
            <span className="text-xs font-medium text-muted">System Health</span>
            <span className="text-[10px] text-muted">{expanded ? '▲ hide details' : '▼ why this score?'}</span>
          </button>
        )}
        <div className="flex flex-col items-center gap-1">
          <span className={`text-4xl font-bold ${
            availability.overallPercent == null ? 'text-muted'
              : availability.overallPercent >= 99 ? 'text-success'
              : availability.overallPercent >= 95 ? 'text-warning'
              : 'text-danger'
          }`}>
            {availability.overallPercent != null ? `${availability.overallPercent}%` : '-'}
          </span>
          <span className="text-xs font-medium text-muted">Availability (24h)</span>
        </div>
      </div>

      {expanded && systemHealthScore?.hostBreakdown && (
        <div className="mt-4 rounded-xl border border-border bg-surface p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-secondary mb-3">Health Breakdown by Host</h3>
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
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-fg">{host.hostId}</div>
                      {visibleFactors.length > 0 ? (
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5">
                          {visibleFactors.map(([key, f]) => (
                            <span key={key} className={`text-xs ${RATING_COLORS[f.rating] || 'text-muted'}`}>
                              {RATING_EMOJI[f.rating] || ''} {FACTOR_LABELS[key] || key}: {formatFactorValue(key, f.value)} ({f.rating})
                            </span>
                          ))}
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
              className="mt-2 text-xs text-muted hover:text-fg"
            >
              {showAllFactors ? '▲ Show less' : '▼ Show all factors'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
