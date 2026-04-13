import type { ContainerDetail, Alert } from '@/types/api';
import { Card } from '@/components/Card';
import { DataTable, type Column } from '@/components/DataTable';
import { StatusDot } from '@/components/StatusDot';
import { Badge } from '@/components/Badge';
import { timeAgo } from '@/lib/formatters';
import { HistorySummary } from './HistorySummary';

const containerAlertsCols: Column<Alert>[] = [
  { header: 'Type', accessor: r => <span className="flex items-center gap-2"><StatusDot status={r.resolved_at ? 'green' : 'red'} />{r.alert_type.replace(/_/g, ' ')}</span> },
  { header: 'Triggered', accessor: r => timeAgo(r.triggered_at) },
  { header: 'Resolved', accessor: r => r.resolved_at ? timeAgo(r.resolved_at) : <Badge text="active" color="red" /> },
  { header: 'Notifications', accessor: r => r.notify_count },
];

interface ContainerHistoryTabProps {
  alerts: Alert[];
  history: ContainerDetail['history'];
}

export function ContainerHistoryTab({ alerts, history }: ContainerHistoryTabProps) {
  return (
    <div className="space-y-8">
      {alerts.length > 0 && (
        <Card title="Alerts">
          <DataTable
            columns={containerAlertsCols}
            data={alerts}
          />
        </Card>
      )}

      <HistorySummary history={history} />
    </div>
  );
}
