import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Alert } from '@/types/api';
import { Card } from '@/components/Card';
import { DataTable, type Column } from '@/components/DataTable';
import { StatusDot } from '@/components/StatusDot';
import { Badge } from '@/components/Badge';
import { timeAgo } from '@/lib/formatters';

const columns: Column<Alert>[] = [
  { header: 'Type', accessor: r => <span className="flex items-center gap-2"><StatusDot status={r.resolved_at ? 'green' : 'red'} /> {r.alert_type.replace(/_/g, ' ')}</span> },
  { header: 'Host', accessor: r => r.host_id },
  { header: 'Target', accessor: r => r.target },
  { header: 'Triggered', accessor: r => timeAgo(r.triggered_at) },
  { header: 'Resolved', accessor: r => r.resolved_at ? timeAgo(r.resolved_at) : <Badge text="active" color="red" /> },
  { header: 'Notifications', accessor: r => r.notify_count },
];

export function AlertsPage() {
  const { data: alerts } = useQuery({ queryKey: ['alerts'], queryFn: () => api<Alert[]>('/alerts?active=false') });

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold" style={{ color: 'var(--text)' }}>Alerts</h1>
      <Card>
        <DataTable columns={columns} data={alerts || []} emptyText="No alerts" />
      </Card>
    </div>
  );
}
