import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import type { Alert } from '@/types/api';
import { Card } from '@/components/Card';
import { DataTable, type Column } from '@/components/DataTable';
import { StatusDot } from '@/components/StatusDot';
import { Badge } from '@/components/Badge';
import { AlertSilenceControls } from '@/components/AlertSilenceControls';
import { timeAgo } from '@/lib/formatters';
import { PageTitle } from '@/components/PageTitle';

const columns: Column<Alert>[] = [
  { header: 'Type', accessor: r => <span className="flex items-center gap-2"><StatusDot status={r.resolved_at ? 'green' : 'red'} /> {r.alert_type.replace(/_/g, ' ')}</span> },
  { header: 'Reason', accessor: r => <span className="text-xs text-secondary">{r.message || `${r.alert_type.replace(/_/g, ' ')} on ${r.target}`}</span>, hideOnMobile: true },
  { header: 'Host', accessor: r => <span className="text-info">{r.host_id}</span> },
  { header: 'Triggered', accessor: r => timeAgo(r.triggered_at) },
  { header: 'Resolved', accessor: r => r.resolved_at ? timeAgo(r.resolved_at) : <Badge text="active" color="red" />, hideOnMobile: true },
  { header: 'Notifications', accessor: r => r.notify_count, hideOnMobile: true },
  {
    header: 'Actions',
    accessor: r => {
      // Container-scoped alerts pass host + container so the mutation
      // invalidates both alerts() and the container detail query.
      const hostScoped = ['disk_full', 'high_host_cpu', 'low_host_memory', 'high_load', 'endpoint_down'];
      const isContainerScoped = !hostScoped.includes(r.alert_type);
      return (
        <AlertSilenceControls
          alert={r}
          hostId={isContainerScoped ? r.host_id : undefined}
          containerName={isContainerScoped ? r.target : undefined}
        />
      );
    },
    hideOnMobile: true,
  },
];

/**
 * Map an alert to the most relevant detail page. Container-scoped alerts
 * link to the container; host-scoped (disk, host CPU/memory/load) link to
 * the host; endpoint alerts link to the endpoint detail page.
 */
function alertLink(alert: Alert): string {
  const hostScoped = ['disk_full', 'high_host_cpu', 'low_host_memory', 'high_load'];
  const endpointScoped = ['endpoint_down'];
  if (hostScoped.includes(alert.alert_type)) {
    return `/hosts/${encodeURIComponent(alert.host_id)}`;
  }
  if (endpointScoped.includes(alert.alert_type)) {
    return `/endpoints`;
  }
  return `/hosts/${encodeURIComponent(alert.host_id)}/containers/${encodeURIComponent(alert.target)}`;
}

export function AlertsPage() {
  const navigate = useNavigate();
  const { data: alerts } = useQuery({ queryKey: queryKeys.alerts(), queryFn: () => api<Alert[]>('/alerts?active=false'), refetchInterval: 30_000 });

  return (
    <div className="space-y-6">
      <PageTitle>Alerts</PageTitle>
      <Card>
        <DataTable
          columns={columns}
          data={alerts || []}
          emptyText="No alerts"
          onRowClick={r => navigate(alertLink(r))}
        />
      </Card>
    </div>
  );
}
