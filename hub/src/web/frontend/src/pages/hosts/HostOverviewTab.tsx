import { useMemo, useState } from 'react';
import type { HostDetail, HostMetricsSnapshot, TimelineResponse, TimelineEntry, ContainerSnapshot } from '@/types/api';
import { Card } from '@/components/Card';
import { Badge } from '@/components/Badge';
import { UptimeTimeline } from '@/components/UptimeTimeline';
import { TimeSeriesChart, type ChartSeries } from '@/components/TimeSeriesChart';
import { fmtPercent, fmtBytesPerSec } from '@/lib/formatters';
import { isInternalContainer, getContainerNamespace, deriveContainerDisplayStatus } from '@/lib/containers';
import { useNamespaceFilter } from '@/hooks/useNamespaceFilter';
import { NamespaceFilterDropdown } from '@/components/NamespaceFilterDropdown';

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
  timeline: TimelineResponse | undefined;
  hostId: string;
  navigate: (to: string) => void;
  isAuthenticated: boolean;
  actionLoading: string | null;
  runAction: (containerName: string, action: string, needsConfirm?: boolean) => void;
  removeContainer: (containerName: string) => Promise<boolean>;
  metricsHistory?: HostMetricsSnapshot[];
}

export function HostOverviewTab({ data, timeline, hostId, navigate: _navigate, isAuthenticated, actionLoading, runAction, removeContainer, metricsHistory }: Props) {
  const [advanced, setAdvanced] = useState(false);

  const chartData = useMemo(
    () => metricsHistory && metricsHistory.length > 0 ? buildHostChartData(metricsHistory) : null,
    [metricsHistory],
  );

  const { namespaces, hidden, filtered, toggle, showAll, isKubernetes } = useNamespaceFilter(data.containers, hostId);

  // Lookup container snapshot by name for the advanced details row.
  const containerByName = useMemo(() => {
    const m = new Map<string, ContainerSnapshot>();
    for (const c of data.containers) m.set(c.container_name, c);
    return m;
  }, [data.containers]);

  // Filter container ribbons to match the namespace filter.
  const visibleContainerEntries = useMemo(() => {
    if (!timeline) return [];
    if (hidden.size === 0) return timeline.containers;
    return timeline.containers.filter(t => {
      const ns = getContainerNamespace(t.name);
      return !ns || !hidden.has(ns);
    });
  }, [timeline, hidden]);

  const renderContainerExtras = (entry: TimelineEntry) => {
    const c = containerByName.get(entry.name);
    if (!c) return null;
    const derived = deriveContainerDisplayStatus(c.status, c.exit_code);
    const memPct = c.memory_limit_mb && c.memory_mb != null && c.memory_limit_mb > 0
      ? Math.round(c.memory_mb / c.memory_limit_mb * 100 * 10) / 10 : null;
    const memLimitCls = memPct == null ? 'text-muted'
      : memPct >= 90 ? 'text-danger'
      : memPct >= 75 ? 'text-warning' : 'text-muted';
    const cpuLimitCls = c.cpu_limit_percent == null ? 'text-muted'
      : c.cpu_limit_percent >= 90 ? 'text-danger'
      : c.cpu_limit_percent >= 75 ? 'text-warning' : 'text-muted';
    const isInternal = isInternalContainer(c.labels);
    const loadingPrefix = `${c.container_name}:`;
    const loading = actionLoading?.startsWith(loadingPrefix);
    const showActions = isAuthenticated && !isInternal && !c.is_stale;

    return (
      <div className="ml-[124px] mr-[60px] mt-1.5 mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 rounded-md bg-bg-secondary px-3 py-2 text-xs">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <Badge text={c.is_stale ? 'stale' : derived.label} color={c.is_stale ? 'gray' : derived.color} />
          <span className="text-muted">CPU <span className="font-mono text-fg">{fmtPercent(c.cpu_percent)}</span>
            {c.cpu_limit_percent != null && !c.is_stale && (
              <span className={`ml-1 ${cpuLimitCls}`}>({c.cpu_limit_percent}% of limit)</span>
            )}
          </span>
          <span className="text-muted">Memory <span className="font-mono text-fg">{c.memory_mb != null ? `${Math.round(c.memory_mb)} MB` : '-'}</span>
            {memPct != null && (
              <span className={`ml-1 ${memLimitCls}`}>/ {Math.round(c.memory_limit_mb!)} MB ({memPct}%)</span>
            )}
          </span>
          <span className="text-muted">Restarts <span className="font-mono text-fg">{c.restart_count}</span></span>
        </div>
        {showActions && (
          <div className="flex gap-1" onClick={e => e.preventDefault()}>
            {c.status === 'running' ? (
              <>
                <button onClick={() => runAction(c.container_name, 'restart')} disabled={!!loading}
                  className="rounded px-2 py-0.5 text-xs text-muted hover:bg-surface-hover disabled:opacity-50">
                  {loading && actionLoading === `${loadingPrefix}restart` ? '...' : 'Restart'}
                </button>
                <button onClick={() => runAction(c.container_name, 'stop')} disabled={!!loading}
                  className="rounded px-2 py-0.5 text-xs text-danger hover:bg-surface-hover disabled:opacity-50">
                  {loading && actionLoading === `${loadingPrefix}stop` ? '...' : 'Stop'}
                </button>
              </>
            ) : (
              <>
                <button onClick={() => runAction(c.container_name, 'start')} disabled={!!loading}
                  className="rounded px-2 py-0.5 text-xs text-success hover:bg-surface-hover disabled:opacity-50">
                  {loading && actionLoading === `${loadingPrefix}start` ? '...' : 'Start'}
                </button>
                <button onClick={() => removeContainer(c.container_name)} disabled={!!loading}
                  className="rounded px-2 py-0.5 text-xs text-danger hover:bg-surface-hover disabled:opacity-50">
                  {loading && actionLoading === `${loadingPrefix}remove` ? '...' : 'Remove'}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {timeline && (timeline.host || timeline.containers.length > 0) && (
        <Card title="Uptime (7 days)" actions={
          <div className="flex items-center gap-4">
            <div className="hidden items-center gap-3 text-[11px] text-muted sm:flex">
              <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-success" />Up</span>
              <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-danger" />Down</span>
              <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-border" />No data</span>
            </div>
            {isKubernetes && (
              <NamespaceFilterDropdown
                namespaces={namespaces}
                hidden={hidden}
                onToggle={toggle}
                onShowAll={showAll}
                clusterId={resolveClusterId(data, hostId)}
              />
            )}
            <button
              type="button"
              onClick={() => setAdvanced(v => !v)}
              className="rounded border border-border bg-surface px-2 py-1 text-xs font-medium text-secondary hover:bg-surface-hover hover:text-fg"
              title="Show container details and actions inline"
            >
              {advanced ? '▴ Hide details' : '▾ Advanced view'}
            </button>
          </div>
        }>
          <div className="space-y-4">
            {timeline.host && (
              <div className="rounded-lg border border-border bg-bg-secondary p-3">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <span className="rounded border border-border bg-surface px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.12em] text-secondary">Host</span>
                  <span className="font-mono text-[10px] text-muted">the machine itself</span>
                </div>
                <UptimeTimeline containers={[timeline.host]} rowHeight={22} />
              </div>
            )}
            {timeline.containers.length > 0 && (
              <div className="ml-2 border-l-2 border-border pl-3">
                <div className="mb-3 flex items-center gap-2">
                  <span className="rounded border border-border bg-surface px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.12em] text-secondary">Containers</span>
                  <span className="font-mono text-[10px] text-muted">
                    {filtered.length} on this host{hidden.size > 0 ? ` (filtered from ${data.containers.length})` : ''}
                  </span>
                </div>
                <UptimeTimeline
                  containers={visibleContainerEntries}
                  hostId={hostId}
                  renderRowExtras={advanced ? renderContainerExtras : undefined}
                />
              </div>
            )}
          </div>
        </Card>
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

    </div>
  );
}

/**
 * Mirror the agent's cluster-id resolution (agent/src/scheduler.ts):
 *   clusterId = host_group_override || host_group || `cluster-${hostId}`.
 * The hub's getClusterIdForHost uses the same precedence, so this stays in
 * sync with the value the topology endpoint expects in its URL.
 */
function resolveClusterId(data: HostDetail, hostId: string): string {
  return data.host_group_override
    || data.host_group
    || `cluster-${hostId}`;
}
