import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { HostDetail, TimelineEntry, Trends, EventItem } from '@/types/api';
import { StatCard, StatsGrid } from '@/components/StatCard';
import { Card } from '@/components/Card';
import { DataTable, type Column } from '@/components/DataTable';
import { StatusDot } from '@/components/StatusDot';
import { Badge } from '@/components/Badge';
import { DiskBar } from '@/components/DiskBar';
import { DiskForecast } from '@/components/DiskForecast';
import { TrendArrow } from '@/components/TrendArrow';
import { UptimeTimeline } from '@/components/UptimeTimeline';
import { EventTimeline } from '@/components/EventTimeline';
import { timeAgo, fmtUptime, fmtPercent, fmtBytesPerSec, fmtCelsius } from '@/lib/formatters';
import { useShowInternal, isInternalContainer } from '@/lib/useShowInternal';

export function HostDetailPage() {
  const { hostId } = useParams();
  const navigate = useNavigate();
  const hid = encodeURIComponent(hostId!);

  const { data } = useQuery({ queryKey: ['host', hostId], queryFn: () => api<HostDetail>(`/hosts/${hid}`) });
  const { data: timeline } = useQuery({ queryKey: ['timeline', hostId], queryFn: () => api<TimelineEntry[]>(`/hosts/${hid}/timeline?days=7`).catch(() => []) });
  const { data: trends } = useQuery({ queryKey: ['trends', hostId], queryFn: () => api<Trends>(`/hosts/${hid}/trends`).catch(() => ({ containers: [], host: null })) });
  const { data: events } = useQuery({ queryKey: ['events', hostId], queryFn: () => api<EventItem[]>(`/hosts/${hid}/events?days=7`).catch(() => []) });

  const { showInternal } = useShowInternal();

  if (!data) return <div className="py-12 text-center text-sm" style={{ color: 'var(--text-muted)' }}>Loading...</div>;

  const hm = data.hostMetrics;
  const filteredContainers = showInternal ? data.containers : data.containers.filter(c => !isInternalContainer(c.labels));

  const containerCols: Column<typeof data.containers[number]>[] = [
    { header: 'Name', accessor: r => <span className="flex items-center gap-2"><StatusDot status={r.status} />{r.container_name}</span> },
    { header: 'Status', accessor: r => <Badge text={r.status} color={r.status === 'running' ? 'green' : 'red'} /> },
    { header: 'CPU', accessor: r => fmtPercent(r.cpu_percent) },
    { header: 'Memory', accessor: r => r.memory_mb != null ? `${Math.round(r.memory_mb)} MB` : '-' },
    { header: 'Restarts', accessor: r => r.restart_count },
  ];

  return (
    <div className="space-y-6">
      <Link to="/hosts" className="text-sm text-blue-500 hover:underline">&larr; Back to Hosts</Link>

      <div className="flex items-center gap-2">
        <StatusDot status={data.is_online ? 'online' : 'offline'} size="lg" />
        <h1 className="text-xl font-bold" style={{ color: 'var(--text)' }}>{data.host_id}</h1>
        <Badge text={data.is_online ? 'online' : 'offline'} color={data.is_online ? 'green' : 'red'} />
      </div>

      {/* Host system metrics */}
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

      {/* Uptime Timeline */}
      {timeline && timeline.length > 0 && (
        <Card title="Uptime (7 days)">
          <UptimeTimeline containers={timeline} />
        </Card>
      )}

      {/* Containers */}
      <Card title="Containers">
        <div className="mb-3 flex justify-end">
          <Link to={`/hosts/${hid}/logs`} className="rounded-lg bg-slate-700 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-600">
            Split Logs
          </Link>
        </div>
        <DataTable
          columns={containerCols}
          data={filteredContainers}
          onRowClick={r => navigate(`/hosts/${hid}/containers/${encodeURIComponent(r.container_name)}`)}
          emptyText="No containers"
        />
      </Card>

      {/* Trends */}
      {trends && trends.containers.length > 0 && (
        <Card title="Trends (vs last week)">
          <DataTable
            columns={[
              { header: 'Container', accessor: (r: typeof trends.containers[number]) => r.name },
              { header: 'CPU Avg', accessor: r => fmtPercent(r.cpuNow) },
              { header: 'CPU Change', accessor: r => <TrendArrow change={r.cpuChange} /> },
              { header: 'Mem Avg', accessor: r => r.memNow != null ? `${r.memNow} MB` : '-' },
              { header: 'Mem Change', accessor: r => <TrendArrow change={r.memChange} /> },
            ]}
            data={trends.containers}
          />
        </Card>
      )}

      {/* Disk */}
      {data.disk.length > 0 && (
        <Card title="Disk Usage">
          <DataTable
            columns={[
              { header: 'Mount', accessor: (r: typeof data.disk[number]) => r.mount_point },
              { header: 'Usage', accessor: r => `${r.used_gb}/${r.total_gb} GB` },
              { header: 'Percent', accessor: r => <DiskBar percent={r.used_percent} /> },
            ]}
            data={data.disk}
          />
          {data.diskForecast && <div className="mt-3"><DiskForecast forecasts={data.diskForecast} /></div>}
        </Card>
      )}

      {/* Alerts */}
      {data.alerts.length > 0 && (
        <Card title="Active Alerts">
          <DataTable
            columns={[
              { header: 'Type', accessor: (r: typeof data.alerts[number]) => r.alert_type.replace(/_/g, ' ') },
              { header: 'Target', accessor: r => r.target },
              { header: 'Triggered', accessor: r => timeAgo(r.triggered_at) },
              { header: 'Notifications', accessor: r => r.notify_count },
            ]}
            data={data.alerts}
          />
        </Card>
      )}

      {/* Events */}
      {events && events.length > 0 && (
        <Card title="Events (7 days)">
          <EventTimeline events={events} />
        </Card>
      )}

      {/* Updates */}
      {data.updates.length > 0 && (
        <Card title="Updates Available">
          <DataTable
            columns={[
              { header: 'Container', accessor: (r: typeof data.updates[number]) => r.container_name },
              { header: 'Image', accessor: r => r.image },
            ]}
            data={data.updates}
          />
        </Card>
      )}
    </div>
  );
}
