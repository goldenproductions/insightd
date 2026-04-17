import { useState, useMemo } from 'react';
import type { HostDetail, HostMetricsSnapshot, TimelineEntry, ContainerSnapshot, BaselineRow } from '@/types/api';
import { StatCard, StatsGrid } from '@/components/StatCard';
import { Card } from '@/components/Card';
import { DataTable, type Column } from '@/components/DataTable';
import { StatusDot } from '@/components/StatusDot';
import { Badge } from '@/components/Badge';
import { LinkButton } from '@/components/FormField';
import { UptimeTimeline } from '@/components/UptimeTimeline';
import { TimeSeriesChart, type ChartSeries } from '@/components/TimeSeriesChart';
import { fmtPercent, fmtUptime, fmtBytesPerSec, fmtCelsius } from '@/lib/formatters';
import { getAnalogy, findBaseline } from '@/lib/analogies';
import { isInternalContainer, getContainerNamespace, getContainerDisplayName } from '@/lib/containers';
import { useNamespaceFilter } from '@/hooks/useNamespaceFilter';
import { NamespaceFilterBar } from '@/components/NamespaceFilterBar';

interface HostChartDataset {
  timestamps: number[];
  cpu: (number | null)[];
  memoryPct: (number | null)[];
  load1: (number | null)[];
  load5: (number | null)[];
  load15: (number | null)[];
  netRx: (number | null)[];
  netTx: (number | null)[];
  diskRead: (number | null)[];
  diskWrite: (number | null)[];
  hasCpu: boolean;
  hasMemory: boolean;
  hasLoad: boolean;
  hasNetwork: boolean;
  hasDisk: boolean;
}

function buildHostChartData(history: HostMetricsSnapshot[]): HostChartDataset {
  const timestamps = history.map((h) =>
    Math.floor(new Date(h.collected_at.includes('T') ? h.collected_at : h.collected_at.replace(' ', 'T') + 'Z').getTime() / 1000),
  );
  const cpu = history.map((h) => h.cpu_percent);
  const memoryPct = history.map((h) =>
    h.memory_total_mb && h.memory_total_mb > 0 && h.memory_used_mb != null
      ? (h.memory_used_mb / h.memory_total_mb) * 100
      : null,
  );
  const load1 = history.map((h) => h.load_1);
  const load5 = history.map((h) => h.load_5);
  const load15 = history.map((h) => h.load_15);
  const netRx = history.map((h) => h.net_rx_bytes_per_sec);
  const netTx = history.map((h) => h.net_tx_bytes_per_sec);
  const diskRead = history.map((h) => h.disk_read_bytes_per_sec);
  const diskWrite = history.map((h) => h.disk_write_bytes_per_sec);

  const any = (xs: (number | null)[]) => xs.some((v) => v != null);

  return {
    timestamps, cpu, memoryPct, load1, load5, load15, netRx, netTx, diskRead, diskWrite,
    hasCpu: any(cpu),
    hasMemory: any(memoryPct),
    hasLoad: any(load1),
    hasNetwork: any(netRx) || any(netTx),
    hasDisk: any(diskRead) || any(diskWrite),
  };
}

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
  metricsHistory?: HostMetricsSnapshot[];
}

export function HostOverviewTab({ data, timeline, hostId, hid, navigate, isAuthenticated, actionLoading, runAction, removeContainer, baselines, metricsHistory }: Props) {
  const hm = data.hostMetrics;
  const [showExtended, setShowExtended] = useState(false);
  // Don't show analogies until baselines have loaded (prevents flicker from static→baseline switch)
  const ready = baselines !== undefined;
  const bl = (metric: string) => findBaseline(baselines, metric);

  const chartData = useMemo(
    () => metricsHistory && metricsHistory.length > 0 ? buildHostChartData(metricsHistory) : null,
    [metricsHistory],
  );

  const { namespaces, hidden, filtered, toggle, showAll, isKubernetes } = useNamespaceFilter(data.containers, hostId);
  const running = filtered.filter(c => c.status === 'running').length;
  const total = filtered.length;
  const totalUnfiltered = data.containers.length;

  const containerCols: Column<ContainerSnapshot>[] = [
    { header: 'Name', accessor: r => {
      const ns = getContainerNamespace(r.container_name);
      const display = getContainerDisplayName(r.container_name);
      return (
        <span className={`flex items-center gap-2 ${r.is_stale ? 'opacity-60' : ''}`}>
          <StatusDot status={r.is_stale ? 'stale' : r.status} />
          {ns ? <span><span className="text-muted">{ns}/</span>{display}</span> : r.container_name}
        </span>
      );
    } },
    { header: 'Status', accessor: r => r.is_stale
      ? <Badge text="stale" color="gray" />
      : <Badge text={r.status} color={r.status === 'running' ? 'green' : 'red'} /> },
    { header: 'CPU', accessor: r => <span className={r.is_stale ? 'text-muted' : ''}>{fmtPercent(r.cpu_percent)}</span> },
    { header: 'Memory', accessor: r => <span className={r.is_stale ? 'text-muted' : ''}>{r.memory_mb != null ? `${Math.round(r.memory_mb)} MB` : '-'}</span> },
    { header: 'Restarts', accessor: r => <span className={r.is_stale ? 'text-muted' : ''}>{r.restart_count}</span> },
    ...(isAuthenticated ? [{
      header: '',
      accessor: (r: ContainerSnapshot) => {
        const isInternal = isInternalContainer(r.labels);
        if (isInternal) return null;
        // Actions require a live agent — hide them when data is stale.
        if (r.is_stale) return null;
        const loading = actionLoading?.startsWith(`${r.container_name}:`);
        return (
          <span className="flex gap-1" onClick={e => e.stopPropagation()}>
            {r.status === 'running' ? (
              <>
                <button onClick={() => runAction(r.container_name, 'restart')} disabled={!!loading}
                  className="rounded px-2 py-0.5 text-xs text-muted hover:bg-surface-hover disabled:opacity-50">
                  {loading && actionLoading === `${r.container_name}:restart` ? '...' : 'Restart'}
                </button>
                <button onClick={() => runAction(r.container_name, 'stop')} disabled={!!loading}
                  className="rounded px-2 py-0.5 text-xs text-danger hover:bg-surface-hover disabled:opacity-50">
                  {loading && actionLoading === `${r.container_name}:stop` ? '...' : 'Stop'}
                </button>
              </>
            ) : (
              <>
                <button onClick={() => runAction(r.container_name, 'start')} disabled={!!loading}
                  className="rounded px-2 py-0.5 text-xs text-success hover:bg-surface-hover disabled:opacity-50">
                  {loading && actionLoading === `${r.container_name}:start` ? '...' : 'Start'}
                </button>
                <button onClick={() => removeContainer(r.container_name)} disabled={!!loading}
                  className="rounded px-2 py-0.5 text-xs text-danger hover:bg-surface-hover disabled:opacity-50">
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
            <div>
              <button
                onClick={() => setShowExtended(!showExtended)}
                className="flex w-full items-center justify-between rounded-xl border border-border bg-surface px-4 py-3 text-sm transition-colors hover:bg-surface-hover"
              >
                <span className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                  {hm.cpu_temperature_celsius != null && <span>CPU {fmtCelsius(hm.cpu_temperature_celsius)}</span>}
                  {hm.gpu_utilization_percent != null && <span>GPU {fmtPercent(hm.gpu_utilization_percent)}</span>}
                  {hm.net_rx_bytes_per_sec != null && <span>Net RX {fmtBytesPerSec(hm.net_rx_bytes_per_sec)}</span>}
                  {hm.net_tx_bytes_per_sec != null && <span>Net TX {fmtBytesPerSec(hm.net_tx_bytes_per_sec)}</span>}
                  {hm.disk_read_bytes_per_sec != null && <span>Disk R {fmtBytesPerSec(hm.disk_read_bytes_per_sec)}</span>}
                  {hm.disk_write_bytes_per_sec != null && <span>Disk W {fmtBytesPerSec(hm.disk_write_bytes_per_sec)}</span>}
                </span>
                <span className="ml-3 shrink-0 text-xs text-muted">{showExtended ? '▲ Less' : '▼ More'}</span>
              </button>
              {showExtended && (
                <div className="mt-3">
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
                </div>
              )}
            </div>
          )}
        </>
      )}

      {chartData && (chartData.hasCpu || chartData.hasMemory || chartData.hasLoad || chartData.hasNetwork || chartData.hasDisk) && (
        <Card title="Metrics (last 24h)">
          <div className="grid gap-5 lg:grid-cols-2">
            {chartData.hasCpu && (
              <TimeSeriesChart
                title="CPU"
                timestamps={chartData.timestamps}
                unit="%"
                series={[{
                  label: 'cpu',
                  color: 'var(--color-success)',
                  values: chartData.cpu,
                  formatValue: (v) => `${v.toFixed(1)}%`,
                }] satisfies ChartSeries[]}
              />
            )}
            {chartData.hasMemory && (
              <TimeSeriesChart
                title="Memory"
                timestamps={chartData.timestamps}
                unit="%"
                series={[{
                  label: 'memory',
                  color: 'var(--color-info)',
                  values: chartData.memoryPct,
                  formatValue: (v) => `${v.toFixed(1)}%`,
                }] satisfies ChartSeries[]}
              />
            )}
            {chartData.hasLoad && (
              <TimeSeriesChart
                title="Load Average"
                timestamps={chartData.timestamps}
                series={[
                  { label: '1m', color: 'var(--color-warning)', values: chartData.load1, formatValue: (v) => v.toFixed(2) },
                  { label: '5m', color: 'var(--color-info)', values: chartData.load5, formatValue: (v) => v.toFixed(2) },
                  { label: '15m', color: '#a855f7', values: chartData.load15, formatValue: (v) => v.toFixed(2) },
                ] satisfies ChartSeries[]}
              />
            )}
            {chartData.hasNetwork && (
              <TimeSeriesChart
                title="Network I/O"
                timestamps={chartData.timestamps}
                series={[
                  { label: 'rx', color: '#0ea5e9', values: chartData.netRx, formatValue: fmtBytesPerSec },
                  { label: 'tx', color: '#f59e0b', values: chartData.netTx, formatValue: fmtBytesPerSec },
                ] satisfies ChartSeries[]}
              />
            )}
            {chartData.hasDisk && (
              <TimeSeriesChart
                title="Disk I/O"
                timestamps={chartData.timestamps}
                series={[
                  { label: 'read', color: '#a855f7', values: chartData.diskRead, formatValue: fmtBytesPerSec },
                  { label: 'write', color: '#ef4444', values: chartData.diskWrite, formatValue: fmtBytesPerSec },
                ] satisfies ChartSeries[]}
              />
            )}
          </div>
        </Card>
      )}

      {isKubernetes && (
        <NamespaceFilterBar
          namespaces={namespaces}
          hidden={hidden}
          onToggle={toggle}
          onShowAll={showAll}
          totalCount={totalUnfiltered}
          visibleCount={total}
        />
      )}

      {timeline && timeline.length > 0 && (
        <Card title="Uptime (7 days)">
          <UptimeTimeline
            containers={hidden.size > 0 ? timeline.filter(t => { const ns = getContainerNamespace(t.name); return !ns || !hidden.has(ns); }) : timeline}
            hostId={hostId}
          />
        </Card>
      )}

      <Card title="Containers" actions={<LinkButton to={`/hosts/${hid}/logs`} variant="ghost" size="sm">Split Logs</LinkButton>}>
        <p className="mb-3 text-xs text-muted">
          {running}/{total} running
          {hidden.size > 0 && <span> (filtered from {totalUnfiltered})</span>}
        </p>
        <DataTable
          columns={containerCols}
          data={filtered}
          onRowClick={r => navigate(`/hosts/${hid}/containers/${encodeURIComponent(r.container_name)}`)}
          emptyText="No containers"
        />
      </Card>
    </div>
  );
}
