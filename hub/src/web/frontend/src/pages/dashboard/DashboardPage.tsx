import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Link } from 'react-router-dom';
import type { DashboardData, Rankings } from '@/types/api';
import { Card } from '@/components/Card';
import { RankingList } from '@/components/RankingList';
import { HealthBadge } from '@/components/HealthBadge';
import { useShowInternal } from '@/hooks/useShowInternal';
import { LoadingState } from '@/components/LoadingState';
import { useAttentionItems } from '@/hooks/useAttentionItems';
import { StatusRow } from './StatusRow';
import { AttentionList } from './AttentionList';

export function DashboardPage() {
  const { showInternal } = useShowInternal();
  const si = showInternal ? '?showInternal=true' : '';
  const { data } = useQuery({ queryKey: ['dashboard', showInternal], queryFn: () => api<DashboardData>(`/dashboard${si}`), refetchInterval: 30_000 });
  const { data: rankings } = useQuery({ queryKey: ['rankings'], queryFn: () => api<Rankings>('/rankings?limit=5'), refetchInterval: 30_000 });

  const attentionItems = useAttentionItems(data);

  if (!data) return <LoadingState />;

  return (
    <div className="space-y-6">
      {/* Hero */}
      <div className="flex items-center justify-center gap-12 py-4">
        {data.systemHealthScore && (
          <div className="flex flex-col items-center gap-1">
            <HealthBadge score={data.systemHealthScore.score} size="lg" />
            <span className="text-xs font-medium text-muted">System Health</span>
          </div>
        )}
        <div className="flex flex-col items-center gap-1">
          <span className={`text-4xl font-bold ${
            data.availability.overallPercent == null ? 'text-muted'
              : data.availability.overallPercent >= 99 ? 'text-success'
              : data.availability.overallPercent >= 95 ? 'text-warning'
              : 'text-danger'
          }`}>
            {data.availability.overallPercent != null ? `${data.availability.overallPercent}%` : '-'}
          </span>
          <span className="text-xs font-medium text-muted">Availability (24h)</span>
        </div>
      </div>

      <StatusRow data={data} />

      <AttentionList attentionItems={attentionItems} />

      {/* Services */}
      {data.groups && data.groups.length > 0 && (
        <Card title="Services">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.groups.map(g => (
              <Link key={g.id} to={`/services/${g.id}`} className="block rounded-lg p-3 hover-surface border border-border" style={{ borderLeft: `3px solid ${g.color || 'var(--color-info)'}` }}
              >
                <div className="font-medium text-sm text-fg">{g.icon && <span className="mr-1">{g.icon}</span>}{g.name}</div>
                <div className="text-xs mt-1 text-muted">
                  <span className={g.running_count === g.member_count ? 'text-emerald-500' : 'text-red-500'}>{g.running_count}/{g.member_count}</span> running
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
            <RankingList items={rankings.byCpu} valueKey="cpu_percent" formatFn={v => v.toFixed(1) + '%'} />
          </Card>
          <Card title="Top Memory">
            <RankingList items={rankings.byMemory} valueKey="memory_mb" formatFn={v => Math.round(v) + ' MB'} />
          </Card>
        </div>
      )}
    </div>
  );
}
