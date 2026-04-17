import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import type { EndpointSummary } from '@/types/api';
import { useAuth } from '@/context/AuthContext';
import { Card } from '@/components/Card';
import { DataTable, type Column } from '@/components/DataTable';
import { StatusDot } from '@/components/StatusDot';
import { Badge } from '@/components/Badge';
import { LinkButton } from '@/components/FormField';
import { timeAgo } from '@/lib/formatters';
import { PageTitle } from '@/components/PageTitle';

export function EndpointsPage() {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  const { data: endpoints } = useQuery({ queryKey: queryKeys.endpoints(), queryFn: () => api<EndpointSummary[]>('/endpoints'), refetchInterval: 30_000 });

  const columns: Column<EndpointSummary>[] = [
    {
      header: 'Name',
      accessor: r => {
        const isUp = r.lastCheck ? r.lastCheck.is_up : null;
        const status = isUp === null ? 'none' : isUp ? 'up' : 'down';
        return <span className="flex items-center gap-2"><StatusDot status={status} /> {r.name}</span>;
      },
    },
    { header: 'URL', accessor: r => <span className="max-w-[250px] truncate text-xs text-muted">{r.url}</span>, hideOnMobile: true },
    { header: 'Uptime (24h)', accessor: r => r.uptimePercent24h != null ? `${r.uptimePercent24h}%` : '-' },
    { header: 'Avg Response', accessor: r => r.avgResponseMs != null ? `${r.avgResponseMs}ms` : '-', hideOnMobile: true },
    { header: 'Last Check', accessor: r => r.lastCheck ? timeAgo(r.lastCheck.checked_at) : 'never', hideOnMobile: true },
    { header: 'Status', accessor: r => r.enabled ? <Badge text="on" color="green" /> : <Badge text="off" color="red" /> },
  ];

  return (
    <div className="space-y-6">
      <PageTitle actions={isAuthenticated ? (
        <LinkButton to="/endpoints/new" variant="primary">
          Add Endpoint
        </LinkButton>
      ) : undefined}>Endpoints</PageTitle>
      <Card>
        <DataTable
          columns={columns}
          data={endpoints || []}
          onRowClick={r => navigate(`/endpoints/${r.id}`)}
          emptyText={isAuthenticated ? 'No endpoints configured. Add one above.' : 'No endpoints configured.'}
        />
      </Card>
    </div>
  );
}
