import type { ContainerDetail, ContainerHistory, Alert } from '@/types/api';
import { Card } from '@/components/Card';
import { DataTable, type Column } from '@/components/DataTable';
import { StatusDot } from '@/components/StatusDot';
import { Badge } from '@/components/Badge';
import { timeAgo, fmtPercent } from '@/lib/formatters';
import { HistorySummary } from './HistorySummary';

const historyCols: Column<ContainerHistory>[] = [
  { header: 'Time', accessor: r => timeAgo(r.collected_at) },
  { header: 'Status', accessor: r => <span className="flex items-center gap-2"><StatusDot status={r.status} />{r.status}</span> },
  { header: 'CPU', accessor: r => fmtPercent(r.cpu_percent) },
  { header: 'Memory', accessor: r => r.memory_mb != null ? `${Math.round(r.memory_mb)} MB` : '-' },
  { header: 'Restarts', accessor: r => r.restart_count },
];

const containerAlertsCols: Column<Alert>[] = [
  { header: 'Type', accessor: r => <span className="flex items-center gap-2"><StatusDot status={r.resolved_at ? 'green' : 'red'} />{r.alert_type.replace(/_/g, ' ')}</span> },
  { header: 'Triggered', accessor: r => timeAgo(r.triggered_at) },
  { header: 'Resolved', accessor: r => r.resolved_at ? timeAgo(r.resolved_at) : <Badge text="active" color="red" /> },
  { header: 'Notifications', accessor: r => r.notify_count },
];

interface ContainerHistoryTabProps {
  alerts: Alert[];
  history: ContainerDetail['history'];
  showSnapshots: boolean;
  setShowSnapshots: (show: boolean) => void;
}

export function ContainerHistoryTab({ alerts, history, showSnapshots, setShowSnapshots }: ContainerHistoryTabProps) {
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

      <div>
        <button
          onClick={() => setShowSnapshots(!showSnapshots)}
          className="mb-3 text-xs font-medium text-muted hover:text-fg transition-colors"
        >
          {showSnapshots ? '▲' : '▼'} {showSnapshots ? 'Hide' : 'Show'} all snapshots ({history.length})
        </button>
        {showSnapshots && (
          <Card>
            <DataTable columns={historyCols} data={[...history].reverse()} emptyText="No history data" />
          </Card>
        )}
      </div>
    </div>
  );
}
