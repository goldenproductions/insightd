import { Link } from 'react-router-dom';
import type { HostDetail, TimelineEntry, ContainerSnapshot } from '@/types/api';
import { StatCard, StatsGrid } from '@/components/StatCard';
import { Card } from '@/components/Card';
import { DataTable, type Column } from '@/components/DataTable';
import { StatusDot } from '@/components/StatusDot';
import { Badge } from '@/components/Badge';
import { UptimeTimeline } from '@/components/UptimeTimeline';
import { fmtPercent, fmtUptime, fmtBytesPerSec, fmtCelsius } from '@/lib/formatters';
import { isInternalContainer } from '@/hooks/useShowInternal';

interface Props {
  data: HostDetail;
  timeline: TimelineEntry[] | undefined;
  hostId: string;
  hid: string;
  navigate: (to: string) => void;
  isAuthenticated: boolean;
  actionLoading: string | null;
  runAction: (containerName: string, action: string, needsConfirm?: boolean) => void;
}

export function HostOverviewTab({ data, timeline, hostId, hid, navigate, isAuthenticated, actionLoading, runAction }: Props) {
  const hm = data.hostMetrics;

  const containerCols: Column<ContainerSnapshot>[] = [
    { header: 'Name', accessor: r => <span className="flex items-center gap-2"><StatusDot status={r.status} />{r.container_name}</span> },
    { header: 'Status', accessor: r => <Badge text={r.status} color={r.status === 'running' ? 'green' : 'red'} /> },
    { header: 'CPU', accessor: r => fmtPercent(r.cpu_percent) },
    { header: 'Memory', accessor: r => r.memory_mb != null ? `${Math.round(r.memory_mb)} MB` : '-' },
    { header: 'Restarts', accessor: r => r.restart_count },
    ...(isAuthenticated ? [{
      header: '',
      accessor: (r: ContainerSnapshot) => {
        const isInternal = isInternalContainer(r.labels);
        if (isInternal) return null;
        const loading = actionLoading?.startsWith(`${r.container_name}:`);
        return (
          <span className="flex gap-1" onClick={e => e.stopPropagation()}>
            {r.status === 'running' ? (
              <>
                <button onClick={() => runAction(r.container_name, 'restart')} disabled={!!loading}
                  className="rounded px-2 py-0.5 text-xs text-slate-300 hover:bg-slate-700 disabled:opacity-50">
                  {loading && actionLoading === `${r.container_name}:restart` ? '...' : 'Restart'}
                </button>
                <button onClick={() => runAction(r.container_name, 'stop')} disabled={!!loading}
                  className="rounded px-2 py-0.5 text-xs text-red-400 hover:bg-slate-700 disabled:opacity-50">
                  {loading && actionLoading === `${r.container_name}:stop` ? '...' : 'Stop'}
                </button>
              </>
            ) : (
              <button onClick={() => runAction(r.container_name, 'start')} disabled={!!loading}
                className="rounded px-2 py-0.5 text-xs text-emerald-400 hover:bg-slate-700 disabled:opacity-50">
                {loading && actionLoading === `${r.container_name}:start` ? '...' : 'Start'}
              </button>
            )}
          </span>
        );
      },
    }] : []),
  ];

  return (
    <div className="space-y-6">
      {hm && (
        <>
          <StatsGrid>
            <StatCard value={fmtPercent(hm.cpu_percent)} label="CPU" />
            <StatCard value={hm.memory_total_mb ? `${Math.round((hm.memory_used_mb || 0) / hm.memory_total_mb * 100)}%` : '-'} label="Memory" />
            <StatCard value={hm.load_1 != null ? String(hm.load_1.toFixed(2)) : '-'} label="Load 1m" />
            <StatCard value={hm.load_5 != null ? String(hm.load_5.toFixed(2)) : '-'} label="Load 5m" />
            <StatCard value={fmtUptime(hm.uptime_seconds)} label="Uptime" />
          </StatsGrid>
          {(hm.cpu_temperature_celsius != null || hm.gpu_utilization_percent != null || hm.disk_read_bytes_per_sec != null || hm.net_rx_bytes_per_sec != null) && (
            <StatsGrid>
              {hm.cpu_temperature_celsius != null && <StatCard value={fmtCelsius(hm.cpu_temperature_celsius)} label="CPU Temp" color={hm.cpu_temperature_celsius > 80 ? 'var(--color-danger)' : hm.cpu_temperature_celsius > 60 ? 'var(--color-warning)' : undefined} />}
              {hm.gpu_utilization_percent != null && <StatCard value={fmtPercent(hm.gpu_utilization_percent)} label="GPU" />}
              {hm.gpu_memory_total_mb != null && <StatCard value={`${Math.round(hm.gpu_memory_used_mb || 0)}/${Math.round(hm.gpu_memory_total_mb)} MB`} label="GPU Memory" />}
              {hm.gpu_temperature_celsius != null && <StatCard value={fmtCelsius(hm.gpu_temperature_celsius)} label="GPU Temp" color={hm.gpu_temperature_celsius > 85 ? 'var(--color-danger)' : hm.gpu_temperature_celsius > 70 ? 'var(--color-warning)' : undefined} />}
              {hm.disk_read_bytes_per_sec != null && <StatCard value={fmtBytesPerSec(hm.disk_read_bytes_per_sec)} label="Disk Read" />}
              {hm.disk_write_bytes_per_sec != null && <StatCard value={fmtBytesPerSec(hm.disk_write_bytes_per_sec)} label="Disk Write" />}
              {hm.net_rx_bytes_per_sec != null && <StatCard value={fmtBytesPerSec(hm.net_rx_bytes_per_sec)} label="Net RX" />}
              {hm.net_tx_bytes_per_sec != null && <StatCard value={fmtBytesPerSec(hm.net_tx_bytes_per_sec)} label="Net TX" />}
            </StatsGrid>
          )}
        </>
      )}

      {timeline && timeline.length > 0 && (
        <Card title="Uptime (7 days)">
          <UptimeTimeline containers={timeline} hostId={hostId} />
        </Card>
      )}

      <Card title="Containers">
        <div className="mb-3 flex justify-end">
          <Link to={`/hosts/${hid}/logs`} className="rounded-lg bg-slate-700 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-600">
            Split Logs
          </Link>
        </div>
        <DataTable
          columns={containerCols}
          data={data.containers}
          onRowClick={r => navigate(`/hosts/${hid}/containers/${encodeURIComponent(r.container_name)}`)}
          emptyText="No containers"
        />
      </Card>
    </div>
  );
}
