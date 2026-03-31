import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { DashboardData, Rankings } from '@/types/api';
import { StatCard, StatsGrid } from '@/components/StatCard';
import { Card } from '@/components/Card';
import { RankingList } from '@/components/RankingList';

export function DashboardPage() {
  const { data } = useQuery({ queryKey: ['dashboard'], queryFn: () => api<DashboardData>('/dashboard') });
  const { data: rankings } = useQuery({ queryKey: ['rankings'], queryFn: () => api<Rankings>('/rankings?limit=5') });

  if (!data) return <Loading />;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold" style={{ color: 'var(--text)' }}>Dashboard</h1>

      <StatsGrid>
        <StatCard value={`${data.hostsOnline}/${data.hostCount}`} label="Hosts Online" color={data.hostsOffline > 0 ? 'var(--color-danger)' : 'var(--color-success)'} />
        <StatCard value={`${data.containersRunning}/${data.totalContainers}`} label="Containers Running" color={data.containersDown > 0 ? 'var(--color-danger)' : 'var(--color-success)'} />
        <StatCard value={data.activeAlerts} label="Active Alerts" color={data.activeAlerts > 0 ? 'var(--color-danger)' : 'var(--color-success)'} />
        <StatCard value={data.diskWarnings} label="Disk Warnings" color={data.diskWarnings > 0 ? 'var(--color-warning)' : 'var(--color-success)'} />
        <StatCard value={data.updatesAvailable} label="Updates Available" />
        {data.endpointsTotal > 0 && (
          <StatCard value={`${data.endpointsUp}/${data.endpointsTotal}`} label="Endpoints Up" color={data.endpointsDown > 0 ? 'var(--color-danger)' : 'var(--color-success)'} />
        )}
      </StatsGrid>

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
