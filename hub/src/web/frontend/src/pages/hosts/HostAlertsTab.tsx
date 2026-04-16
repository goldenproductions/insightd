import type { HostDetail, EventItem, Alert } from '@/types/api';
import { Card } from '@/components/Card';
import { DataTable, type Column } from '@/components/DataTable';
import { EventTimeline } from '@/components/EventTimeline';
import { EmptyState } from '@/components/EmptyState';
import { AlertSilenceControls } from '@/components/AlertSilenceControls';
import { timeAgo, formatAlertType } from '@/lib/formatters';

interface Props {
  data: HostDetail;
  events: EventItem[] | undefined;
  hostId: string;
}

export function HostAlertsTab({ data, events, hostId }: Props) {
  const alertsCols: Column<Alert>[] = [
    { header: 'Type', accessor: r => formatAlertType(r.alert_type) },
    { header: 'Reason', accessor: r => <span className="text-xs text-secondary">{r.message || r.target}</span> },
    { header: 'Triggered', accessor: r => <span title={r.triggered_at}>{timeAgo(r.triggered_at)}</span> },
    {
      header: 'Reminders',
      headerTooltip: 'How many reminder notifications have been sent. After the first send, reminders slow down — see Settings → Alerts → Slow down reminders.',
      accessor: r => r.notify_count,
    },
    { header: '', accessor: r => <AlertSilenceControls alert={r} hostId={hostId} /> },
  ];

  return (
    <div className="space-y-6">
      {data.alerts.length > 0 && (
        <Card title="Active Alerts">
          <DataTable
            columns={alertsCols}
            data={data.alerts}
          />
        </Card>
      )}

      {events && events.length > 0 && (
        <Card title="Events (7 days)">
          <EventTimeline events={events} />
        </Card>
      )}

      {data.alerts.length === 0 && (!events || events.length === 0) && (
        <EmptyState message="No alerts or events" />
      )}
    </div>
  );
}
