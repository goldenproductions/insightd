import type { HostDetail, TimelineEntry, ContainerSnapshot, BaselineRow } from '@/types/api';
import { StatCard, StatsGrid } from '@/components/StatCard';
import { Card } from '@/components/Card';
import { DataTable, type Column } from '@/components/DataTable';
import { StatusDot } from '@/components/StatusDot';
import { Badge } from '@/components/Badge';
import { LinkButton } from '@/components/FormField';
import { UptimeTimeline } from '@/components/UptimeTimeline';
import { fmtPercent, fmtUptime, fmtBytesPerSec, fmtCelsius } from '@/lib/formatters';
import { getAnalogy, findBaseline } from '@/lib/analogies';
import { isInternalContainer } from '@/lib/containers';

interface Props {
  data: HostDetail;
  timeline: TimelineEntry[] | undefined;
  hostId: string;
  hid: string;
  navigate: (to: string) => void;
  isAuthenticated: boolean;
  actionLoading: string | null;
  runAction: (containerName: string, action: string, needsConfirm?: boolean) => void;
  removeContainer: (containerName: string) => Promise<boolean>;
  baselines?: BaselineRow[];
}

export function HostOverviewTab({ data, timeline, hostId, hid, navigate, isAuthenticated, actionLoading, runAction, removeContainer, baselines }: Props) {
  const hm = data.hostMetrics;
  // Don't show analogies until baselines have loaded (prevents flicker from static→baseline switch)
  const ready = baselines !== undefined;
  const bl = (metric: string) => findBaseline(baselines, metric);

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
                  className="rounded px-2 py-0.5 text-xs text-danger hover:bg-slate-700 disabled:opacity-50">
                  {loading && actionLoading === `${r.container_name}:stop` ? '...' : 'Stop'}
                </button>
              </>
            ) : (
              <>
                <button onClick={() => runAction(r.container_name, 'start')} disabled={!!loading}
                  className="rounded px-2 py-0.5 text-xs text-success hover:bg-slate-700 disabled:opacity-50">
                  {loading && actionLoading === `${r.container_name}:start` ? '...' : 'Start'}
                </button>
                <button onClick={() => removeContainer(r.container_name)} disabled={!!loading}
                  className="rounded px-2 py-0.5 text-xs text-danger hover:bg-slate-700 disabled:opacity-50">
                  {loading && actionLoading === `${r.container_name}:remove` ? '...' : 'Remove'}
                </button>
              </>
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
            <StatCard value={fmtPercent(hm.cpu_percent)} label="CPU" analogy={ready ? getAnalogy('cpu', hm.cpu_percent, null, bl('cpu_percent')) : null} />
            <StatCard value={hm.memory_total_mb ? `${Math.round((hm.memory_used_mb || 0) / hm.memory_total_mb * 100)}%` : '-'} label="Memory" analogy={ready ? getAnalogy('memory', hm.memory_used_mb, hm.memory_total_mb, bl('memory_used_mb')) : null} />
            <StatCard value={hm.load_1 != null ? String(hm.load_1.toFixed(2)) : '-'} label="Load 1m" analogy={ready ? getAnalogy('load', hm.load_1, null, bl('load_1')) : null} />
            <StatCard value={hm.load_5 != null ? String(hm.load_5.toFixed(2)) : '-'} label="Load 5m" analogy={ready ? getAnalogy('load', hm.load_5, null, bl('load_5')) : null} />
            <StatCard value={fmtUptime(hm.uptime_seconds)} label="Uptime" />
          </StatsGrid>
          {(hm.cpu_temperature_celsius != null || hm.gpu_utilization_percent != null || hm.disk_read_bytes_per_sec != null || hm.net_rx_bytes_per_sec != null) && (
            <StatsGrid>
              {hm.cpu_temperature_celsius != null && <StatCard value={fmtCelsius(hm.cpu_temperature_celsius)} label="CPU Temp" color={hm.cpu_temperature_celsius > 80 ? 'var(--color-danger)' : hm.cpu_temperature_celsius > 60 ? 'var(--color-warning)' : undefined} analogy={ready ? getAnalogy('temperature', hm.cpu_temperature_celsius) : null} />}
              {hm.gpu_utilization_percent != null && <StatCard value={fmtPercent(hm.gpu_utilization_percent)} label="GPU" analogy={ready ? getAnalogy('cpu', hm.gpu_utilization_percent, null, bl('gpu_utilization_percent')) : null} />}
              {hm.gpu_memory_total_mb != null && <StatCard value={`${Math.round(hm.gpu_memory_used_mb || 0)}/${Math.round(hm.gpu_memory_total_mb)} MB`} label="GPU Memory" analogy={ready ? getAnalogy('memory', hm.gpu_memory_used_mb, hm.gpu_memory_total_mb) : null} />}
              {hm.gpu_temperature_celsius != null && <StatCard value={fmtCelsius(hm.gpu_temperature_celsius)} label="GPU Temp" color={hm.gpu_temperature_celsius > 85 ? 'var(--color-danger)' : hm.gpu_temperature_celsius > 70 ? 'var(--color-warning)' : undefined} analogy={ready ? getAnalogy('temperature', hm.gpu_temperature_celsius) : null} />}
              {hm.disk_read_bytes_per_sec != null && <StatCard value={fmtBytesPerSec(hm.disk_read_bytes_per_sec)} label="Disk Read" analogy={ready ? getAnalogy('network', hm.disk_read_bytes_per_sec, null, bl('disk_read_bytes_per_sec')) : null} />}
              {hm.disk_write_bytes_per_sec != null && <StatCard value={fmtBytesPerSec(hm.disk_write_bytes_per_sec)} label="Disk Write" analogy={ready ? getAnalogy('network', hm.disk_write_bytes_per_sec, null, bl('disk_write_bytes_per_sec')) : null} />}
              {hm.net_rx_bytes_per_sec != null && <StatCard value={fmtBytesPerSec(hm.net_rx_bytes_per_sec)} label="Net RX" analogy={ready ? getAnalogy('network', hm.net_rx_bytes_per_sec, null, bl('net_rx_bytes_per_sec')) : null} />}
              {hm.net_tx_bytes_per_sec != null && <StatCard value={fmtBytesPerSec(hm.net_tx_bytes_per_sec)} label="Net TX" analogy={ready ? getAnalogy('network', hm.net_tx_bytes_per_sec, null, bl('net_tx_bytes_per_sec')) : null} />}
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
          <LinkButton to={`/hosts/${hid}/logs`} variant="ghost" size="sm">Split Logs</LinkButton>
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
