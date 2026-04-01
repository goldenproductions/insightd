import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Link } from 'react-router-dom';
import type { DashboardData, Rankings } from '@/types/api';
import { StatCard, StatsGrid } from '@/components/StatCard';
import { Card } from '@/components/Card';
import { RankingList } from '@/components/RankingList';
import { HealthBadge } from '@/components/HealthBadge';
import { InsightsFeed } from '@/components/InsightsFeed';
import { useShowInternal } from '@/lib/useShowInternal';

export function DashboardPage() {
  const { showInternal } = useShowInternal();
  const si = showInternal ? '?showInternal=true' : '';
  const { data } = useQuery({ queryKey: ['dashboard', showInternal], queryFn: () => api<DashboardData>(`/dashboard${si}`) });
  const { data: rankings } = useQuery({ queryKey: ['rankings'], queryFn: () => api<Rankings>('/rankings?limit=5') });

  if (!data) return <Loading />;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <h1 className="text-xl font-bold" style={{ color: 'var(--text)' }}>Dashboard</h1>
        {data.systemHealthScore && <HealthBadge score={data.systemHealthScore.score} size="md" />}
      </div>

      <StatsGrid>
        <StatCard value={`${data.hostsOnline}/${data.hostCount}`} label="Hosts Online" color={data.hostsOffline > 0 ? 'var(--color-danger)' : 'var(--color-success)'} />
        <StatCard value={`${data.containersRunning}/${data.totalContainers}`} label="Containers Running" color={data.containersDown > 0 ? 'var(--color-danger)' : 'var(--color-success)'} />
        <StatCard value={data.activeAlerts} label="Active Alerts" color={data.activeAlerts > 0 ? 'var(--color-danger)' : 'var(--color-success)'} />
        <StatCard value={data.diskWarnings} label="Disk Warnings" color={data.diskWarnings > 0 ? 'var(--color-warning)' : 'var(--color-success)'} />
        <StatCard value={data.updatesAvailable} label="Updates Available" to="/updates" color={data.updatesAvailable > 0 ? 'var(--color-info)' : undefined} />
        {data.endpointsTotal > 0 && (
          <StatCard value={`${data.endpointsUp}/${data.endpointsTotal}`} label="Endpoints Up" color={data.endpointsDown > 0 ? 'var(--color-danger)' : 'var(--color-success)'} />
        )}
      </StatsGrid>

      {data.groups && data.groups.length > 0 && (
        <Card title="Services">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.groups.map(g => (
              <Link key={g.id} to={`/services/${g.id}`} className="block rounded-lg p-3 transition-colors" style={{ border: '1px solid var(--border)', borderLeft: `3px solid ${g.color || 'var(--color-info)'}` }}
                onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--surface-hover)')}
                onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
              >
                <div className="font-medium text-sm" style={{ color: 'var(--text)' }}>{g.icon && <span className="mr-1">{g.icon}</span>}{g.name}</div>
                <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                  <span className={g.running_count === g.member_count ? 'text-emerald-500' : 'text-red-500'}>{g.running_count}/{g.member_count}</span> running
                </div>
              </Link>
            ))}
          </div>
        </Card>
      )}

      {data.topInsights && data.topInsights.length > 0 && (
        <Card title="Insights">
          <InsightsFeed insights={data.topInsights as { entity_type: string; entity_id: string; category: string; severity: 'info' | 'warning' | 'critical'; title: string; message: string }[]} />
        </Card>
      )}

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

function Loading() {
  return <div className="py-12 text-center text-sm" style={{ color: 'var(--text-muted)' }}>Loading...</div>;
}
