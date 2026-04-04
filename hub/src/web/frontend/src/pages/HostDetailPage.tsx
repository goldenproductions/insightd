import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiAuth } from '@/lib/api';
import type { HostDetail, TimelineEntry, Trends, EventItem, ContainerTrend, DiskSnapshot, UpdateCheck, Alert } from '@/types/api';
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
import { Tabs } from '@/components/Tabs';
import { timeAgo, fmtUptime, fmtPercent, fmtBytesPerSec, fmtCelsius } from '@/lib/formatters';
import { useShowInternal, isInternalContainer } from '@/lib/useShowInternal';
import { useAuth } from '@/context/AuthContext';

const trendsCols: Column<ContainerTrend>[] = [
  { header: 'Container', accessor: r => r.name },
  { header: 'CPU Avg', accessor: r => fmtPercent(r.cpuNow) },
  { header: 'CPU Change', accessor: r => <TrendArrow change={r.cpuChange} /> },
  { header: 'Mem Avg', accessor: r => r.memNow != null ? `${r.memNow} MB` : '-' },
  { header: 'Mem Change', accessor: r => <TrendArrow change={r.memChange} /> },
];

const diskCols: Column<DiskSnapshot>[] = [
  { header: 'Mount', accessor: r => r.mount_point },
  { header: 'Usage', accessor: r => `${r.used_gb}/${r.total_gb} GB` },
  { header: 'Percent', accessor: r => <DiskBar percent={r.used_percent} /> },
];

const updatesCols: Column<UpdateCheck>[] = [
  { header: 'Container', accessor: r => r.container_name },
  { header: 'Image', accessor: r => r.image },
];

const alertsCols: Column<Alert>[] = [
  { header: 'Type', accessor: r => r.alert_type.replace(/_/g, ' ') },
  { header: 'Target', accessor: r => r.target },
  { header: 'Triggered', accessor: r => timeAgo(r.triggered_at) },
  { header: 'Notifications', accessor: r => r.notify_count },
];

export function HostDetailPage() {
  const { hostId } = useParams();
  const navigate = useNavigate();
  const { isAuthenticated, token } = useAuth();
  const queryClient = useQueryClient();
  const { showInternal } = useShowInternal();
  const hid = encodeURIComponent(hostId!);
  const si = showInternal ? '?showInternal=true' : '';
  const [activeTab, setActiveTab] = useState('overview');
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<{ ok: boolean; message: string } | null>(null);

  const { data } = useQuery({ queryKey: ['host', hostId, showInternal], queryFn: () => api<HostDetail>(`/hosts/${hid}${si}`), refetchInterval: 30_000 });
  const { data: timeline } = useQuery({ queryKey: ['timeline', hostId], queryFn: () => api<TimelineEntry[]>(`/hosts/${hid}/timeline?days=7`).catch(() => []) });
  const { data: trends } = useQuery({ queryKey: ['trends', hostId], queryFn: () => api<Trends>(`/hosts/${hid}/trends`).catch(() => ({ containers: [], host: null })) });
  const { data: events } = useQuery({ queryKey: ['events', hostId], queryFn: () => api<EventItem[]>(`/hosts/${hid}/events?days=7`).catch(() => []) });

  if (!data) return <div className="py-12 text-center text-sm" style={{ color: 'var(--text-muted)' }}>Loading...</div>;

  const hm = data.hostMetrics;
  const alertCount = data.alerts.length + (events?.length ?? 0);

  const runAction = async (containerName: string, action: string) => {
    if (action !== 'start' && !window.confirm(`${action.charAt(0).toUpperCase() + action.slice(1)} container "${containerName}"?`)) return;
    setActionLoading(`${containerName}:${action}`);
    setActionResult(null);
    try {
      const res = await apiAuth('POST', `/hosts/${hid}/containers/${encodeURIComponent(containerName)}/action`, { action }, token) as { status: string; message?: string; error?: string };
      setActionResult({ ok: res.status === 'success', message: res.message || res.error || `${action} completed` });
      await queryClient.invalidateQueries({ queryKey: ['host', hostId, showInternal] });
    } catch (err) {
      setActionResult({ ok: false, message: err instanceof Error ? err.message : 'Action failed' });
    }
    setActionLoading(null);
  };

  const containerCols: Column<typeof data.containers[number]>[] = [
    { header: 'Name', accessor: r => <span className="flex items-center gap-2"><StatusDot status={r.status} />{r.container_name}</span> },
    { header: 'Status', accessor: r => <Badge text={r.status} color={r.status === 'running' ? 'green' : 'red'} /> },
    { header: 'CPU', accessor: r => fmtPercent(r.cpu_percent) },
    { header: 'Memory', accessor: r => r.memory_mb != null ? `${Math.round(r.memory_mb)} MB` : '-' },
    { header: 'Restarts', accessor: r => r.restart_count },
    ...(isAuthenticated ? [{
      header: '',
      accessor: (r: typeof data.containers[number]) => {
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

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'resources', label: 'Resources' },
    { id: 'alerts', label: 'Alerts', count: alertCount },
  ];

  return (
    <div className="space-y-6">
      <Link to="/hosts" className="text-sm text-blue-500 hover:underline">&larr; Back to Hosts</Link>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <StatusDot status={data.is_online ? 'online' : 'offline'} size="lg" />
          <h1 className="text-xl font-bold" style={{ color: 'var(--text)' }}>{data.host_id}</h1>
          <Badge text={data.is_online ? 'online' : 'offline'} color={data.is_online ? 'green' : 'red'} />
        </div>
        <RemoveHostButton hostId={hostId!} />
      </div>

      <Tabs tabs={tabs} active={activeTab} onChange={setActiveTab} />

      {actionResult && (
        <div className="rounded-lg px-3 py-2 text-sm" style={{
          backgroundColor: actionResult.ok ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)',
          color: actionResult.ok ? 'var(--color-success)' : 'var(--color-danger)',
        }}>
          {actionResult.message}
        </div>
      )}

      {/* Overview Tab */}
      {activeTab === 'overview' && (
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
              <UptimeTimeline containers={timeline} hostId={hostId!} />
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
      )}

      {/* Resources Tab */}
      {activeTab === 'resources' && (
        <div className="space-y-6">
          {trends && trends.containers.length > 0 && (
            <Card title="Trends (vs last week)">
              <DataTable
                columns={trendsCols}
                data={trends.containers}
              />
            </Card>
          )}

          {data.disk.length > 0 && (
            <Card title="Disk Usage">
              <DataTable
                columns={diskCols}
                data={data.disk}
              />
              {data.diskForecast && <div className="mt-3"><DiskForecast forecasts={data.diskForecast} /></div>}
            </Card>
          )}

          {data.updates.length > 0 && (
            <Card title="Updates Available">
              <DataTable
                columns={updatesCols}
                data={data.updates}
              />
            </Card>
          )}

          {(!trends || trends.containers.length === 0) && data.disk.length === 0 && data.updates.length === 0 && (
            <p className="py-12 text-center text-sm" style={{ color: 'var(--text-muted)' }}>No resource data available</p>
          )}
        </div>
      )}

      {/* Alerts Tab */}
      {activeTab === 'alerts' && (
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
            <p className="py-12 text-center text-sm" style={{ color: 'var(--text-muted)' }}>No alerts or events</p>
          )}
        </div>
      )}
    </div>
  );
}

function RemoveHostButton({ hostId }: { hostId: string }) {
  const { isAuthenticated, token } = useAuth();
  const navigate = useNavigate();

  if (!isAuthenticated) return null;

  const remove = async () => {
    if (!confirm(`Remove host "${hostId}" and all its data? This cannot be undone.`)) return;
    try {
      await apiAuth('DELETE', `/hosts/${encodeURIComponent(hostId)}`, undefined, token);
      navigate('/hosts');
    } catch { /* ignore */ }
  };

  return (
    <button onClick={remove} className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700">
      Remove Host
    </button>
  );
}
