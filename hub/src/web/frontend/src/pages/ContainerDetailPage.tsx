import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { ContainerDetail } from '@/types/api';
import { StatCard, StatsGrid } from '@/components/StatCard';
import { Card } from '@/components/Card';
import { BarChart } from '@/components/BarChart';
import { DataTable, type Column } from '@/components/DataTable';
import { StatusDot } from '@/components/StatusDot';
import { Badge } from '@/components/Badge';
import { LogViewer } from '@/components/LogViewer';
import { timeAgo, fmtBytes, fmtPercent } from '@/lib/formatters';

export function ContainerDetailPage() {
  const { hostId, containerName } = useParams();
  const hid = encodeURIComponent(hostId!);
  const cname = encodeURIComponent(containerName!);

  const { data } = useQuery({
    queryKey: ['container', hostId, containerName],
    queryFn: () => api<ContainerDetail>(`/hosts/${hid}/containers/${cname}`),
  });

  if (!data) return <div className="py-12 text-center text-sm" style={{ color: 'var(--text-muted)' }}>Loading...</div>;

  const history = data.history || [];

  // Derived stats
  const runningCount = history.filter(h => h.status === 'running').length;
  const uptimePct = history.length > 0 ? Math.round((runningCount / history.length) * 1000) / 10 : null;

  const cpuValues = history.filter(h => h.cpu_percent != null).map(h => h.cpu_percent!);
  const memValues = history.filter(h => h.memory_mb != null).map(h => h.memory_mb!);

  const avgCpu = cpuValues.length > 0 ? Math.round(cpuValues.reduce((a, b) => a + b, 0) / cpuValues.length * 10) / 10 : null;
  const maxCpu = cpuValues.length > 0 ? Math.round(Math.max(...cpuValues) * 10) / 10 : null;
  const avgMem = memValues.length > 0 ? Math.round(memValues.reduce((a, b) => a + b, 0) / memValues.length) : null;
  const maxMem = memValues.length > 0 ? Math.round(Math.max(...memValues)) : null;

  const firstRestart = history.length > 0 ? history[0]!.restart_count : 0;
  const lastRestart = history.length > 0 ? history[history.length - 1]!.restart_count : 0;
  const restartDelta = Math.max(0, lastRestart - firstRestart);

  const healthBadge = data.health_status
    ? <Badge text={data.health_status} color={data.health_status === 'healthy' ? 'green' : data.health_status === 'unhealthy' ? 'red' : 'yellow'} />
    : '-';

  const historyCols: Column<typeof history[number]>[] = [
    { header: 'Time', accessor: r => timeAgo(r.collected_at) },
    { header: 'Status', accessor: r => <span className="flex items-center gap-2"><StatusDot status={r.status} />{r.status}</span> },
    { header: 'CPU', accessor: r => fmtPercent(r.cpu_percent) },
    { header: 'Memory', accessor: r => r.memory_mb != null ? `${Math.round(r.memory_mb)} MB` : '-' },
    { header: 'Restarts', accessor: r => r.restart_count },
  ];

  return (
    <div className="space-y-6">
      <Link to={`/hosts/${hid}`} className="text-sm text-blue-500 hover:underline">&larr; Back to {hostId}</Link>

      <div className="flex items-center gap-2">
        <StatusDot status={data.status} size="lg" />
        <h1 className="text-xl font-bold" style={{ color: 'var(--text)' }}>{data.container_name}</h1>
      </div>

      <StatsGrid>
        <StatCard value={data.status} label="Status" />
        <StatCard value={healthBadge} label="Health" />
        <StatCard value={uptimePct != null ? `${uptimePct}%` : '-'} label="Uptime (24h)" />
        <StatCard value={fmtPercent(data.cpu_percent)} label="CPU Now" />
        <StatCard value={data.memory_mb != null ? `${Math.round(data.memory_mb)} MB` : '-'} label="Memory Now" />
        <StatCard value={restartDelta} label="Restarts (24h)" />
      </StatsGrid>

      <StatsGrid>
        <StatCard value={avgCpu != null ? `${avgCpu}%` : '-'} label="Avg CPU (24h)" />
        <StatCard value={maxCpu != null ? `${maxCpu}%` : '-'} label="Peak CPU (24h)" />
        <StatCard value={avgMem != null ? `${avgMem} MB` : '-'} label="Avg Memory (24h)" />
        <StatCard value={maxMem != null ? `${maxMem} MB` : '-'} label="Peak Memory (24h)" />
        <StatCard value={fmtBytes(data.network_rx_bytes)} label="Net RX" />
        <StatCard value={fmtBytes(data.network_tx_bytes)} label="Net TX" />
        <StatCard value={fmtBytes(data.blkio_read_bytes)} label="Disk Read" />
        <StatCard value={fmtBytes(data.blkio_write_bytes)} label="Disk Write" />
      </StatsGrid>

      {/* CPU Chart */}
      {cpuValues.length > 1 && (
        <Card title="CPU (last 24h)">
          <BarChart values={cpuValues} minLabel="0%" maxLabel={`${Math.max(...cpuValues).toFixed(0)}%`} />
        </Card>
      )}

      {/* Memory Chart */}
      {memValues.length > 1 && (
        <Card title="Memory (last 24h)">
          <BarChart values={memValues} colorFn={() => 'var(--color-info)'} minLabel="0 MB" maxLabel={`${Math.max(...memValues).toFixed(0)} MB`} />
        </Card>
      )}

      {/* Alerts */}
      {data.alerts.length > 0 && (
        <Card title="Alerts">
          <DataTable
            columns={[
              { header: 'Type', accessor: (r: typeof data.alerts[number]) => <span className="flex items-center gap-2"><StatusDot status={r.resolved_at ? 'green' : 'red'} />{r.alert_type.replace(/_/g, ' ')}</span> },
              { header: 'Triggered', accessor: r => timeAgo(r.triggered_at) },
              { header: 'Resolved', accessor: r => r.resolved_at ? timeAgo(r.resolved_at) : <Badge text="active" color="red" /> },
              { header: 'Notifications', accessor: r => r.notify_count },
            ]}
            data={data.alerts}
          />
        </Card>
      )}

      {/* Logs */}
      <Card title="Logs">
        <LogViewer hostId={hostId!} containerName={containerName!} />
      </Card>

      {/* History */}
      <Card title={`History (${history.length} snapshots)`}>
        <DataTable columns={historyCols} data={[...history].reverse().slice(0, 50)} emptyText="No history data" />
      </Card>
    </div>
  );
}
