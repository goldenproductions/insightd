import type { ContainerDetail, Alert } from '@/types/api';
import { Card } from '@/components/Card';
import { DataTable, type Column } from '@/components/DataTable';
import { StatusDot } from '@/components/StatusDot';
import { Badge } from '@/components/Badge';
import { AlertSilenceControls } from '@/components/AlertSilenceControls';
import { timeAgo, formatAlertType } from '@/lib/formatters';
import { HistorySummary } from './HistorySummary';

interface ContainerHistoryTabProps {
  alerts: Alert[];
  history: ContainerDetail['history'];
  hostId?: string;
  containerName?: string;
}

export function ContainerHistoryTab({ alerts, history, hostId, containerName }: ContainerHistoryTabProps) {
  const containerAlertsCols: Column<Alert>[] = [
    { header: 'Type', accessor: r => <span className="flex items-center gap-2"><StatusDot status={r.resolved_at ? 'green' : 'red'} />{formatAlertType(r.alert_type)}</span> },
    { header: 'Triggered', accessor: r => <span title={r.triggered_at}>{timeAgo(r.triggered_at)}</span> },
    { header: 'Resolved', accessor: r => r.resolved_at ? <span title={r.resolved_at}>{timeAgo(r.resolved_at)}</span> : <Badge text="active" color="red" /> },
    {
      header: 'Reminders',
      headerTooltip: 'How many reminder notifications have been sent. After the first send, reminders slow down — see Settings → Alerts → Slow down reminders.',
      accessor: r => r.notify_count,
    },
    { header: 'Actions', accessor: r => <AlertSilenceControls alert={r} hostId={hostId} containerName={containerName} /> },
  ];

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
