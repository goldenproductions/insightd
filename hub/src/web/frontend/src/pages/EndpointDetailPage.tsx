import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { EndpointDetail, EndpointCheck } from '@/types/api';
import { useAuth } from '@/context/AuthContext';
import { StatCard, StatsGrid } from '@/components/StatCard';
import { Card } from '@/components/Card';
import { BarChart } from '@/components/BarChart';
import { DataTable, type Column } from '@/components/DataTable';
import { StatusDot } from '@/components/StatusDot';
import { timeAgo } from '@/lib/formatters';
import { BackLink } from '@/components/BackLink';
import { LoadingState } from '@/components/LoadingState';

export function EndpointDetailPage() {
  const { endpointId } = useParams();
  const { isAuthenticated } = useAuth();
  const { data } = useQuery({ queryKey: ['endpoint', endpointId], queryFn: () => api<EndpointDetail>(`/endpoints/${endpointId}`), refetchInterval: 30_000 });
  const { data: checks } = useQuery({ queryKey: ['endpoint-checks', endpointId], queryFn: () => api<EndpointCheck[]>(`/endpoints/${endpointId}/checks?hours=24`), refetchInterval: 30_000 });

  if (!data) return <LoadingState />;

  const isUp = data.lastCheck ? data.lastCheck.is_up : null;
  const statusText = isUp === null ? 'No data' : isUp ? 'Up' : 'Down';
  const statusColor = isUp === null ? 'var(--text-muted)' : isUp ? 'var(--color-success)' : 'var(--color-danger)';

  const rtValues = (checks || []).filter(c => c.response_time_ms != null).reverse().map(c => c.response_time_ms!);
  const rtColorFn = (v: number) => v > 2000 ? 'var(--color-danger)' : v > 500 ? 'var(--color-warning)' : 'var(--color-success)';

  const checkColumns: Column<EndpointCheck>[] = [
    { header: 'Time', accessor: r => timeAgo(r.checked_at) },
    { header: 'Status', accessor: r => <span className="flex items-center gap-2"><StatusDot status={r.is_up ? 'up' : 'down'} />{r.status_code || '-'}</span> },
    { header: 'Response', accessor: r => r.response_time_ms != null ? `${r.response_time_ms}ms` : '-' },
    { header: 'Error', accessor: r => r.error || '-', className: 'text-xs' },
  ];

  return (
    <div className="space-y-6">
      <BackLink to="/endpoints" label="Back to Endpoints" />

      <div className="flex items-center gap-3">
        <StatusDot status={isUp ? 'up' : isUp === 0 ? 'down' : 'none'} size="lg" />
        <h1 className="text-xl font-bold text-fg">{data.name}</h1>
        {isAuthenticated && (
          <Link to={`/endpoints/${endpointId}/edit`} className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700">Edit</Link>
        )}
      </div>

      <p className="text-sm text-muted">
        {data.url} &middot; {data.method} &middot; Expects {data.expected_status} &middot; Every {data.interval_seconds}s
      </p>

      <StatsGrid>
        <StatCard value={statusText} label="Current" color={statusColor} />
        <StatCard value={data.uptimePercent24h != null ? `${data.uptimePercent24h}%` : '-'} label="Uptime (24h)" />
        <StatCard value={data.uptimePercent7d != null ? `${data.uptimePercent7d}%` : '-'} label="Uptime (7d)" />
        <StatCard value={data.avgResponseMs != null ? `${data.avgResponseMs}ms` : '-'} label="Avg Response (24h)" />
        <StatCard value={data.lastCheck?.response_time_ms != null ? `${data.lastCheck.response_time_ms}ms` : '-'} label="Last Response" />
      </StatsGrid>

      {rtValues.length > 1 && (
        <Card title="Response Time (last 24h)">
          <BarChart values={rtValues} colorFn={rtColorFn} minLabel="0ms" maxLabel={`${Math.max(...rtValues)}ms`} />
        </Card>
      )}

      <Card title={`Check History (${(checks || []).length} checks)`}>
        <DataTable columns={checkColumns} data={(checks || []).slice(0, 50)} emptyText="No checks yet" />
      </Card>
    </div>
  );
}
