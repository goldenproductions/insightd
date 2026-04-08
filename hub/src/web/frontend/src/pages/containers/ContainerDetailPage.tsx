import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import type { ContainerDetail, ContainerAvailability, BaselineRow } from '@/types/api';
import type { Baseline } from '@/lib/analogies';
import { Card } from '@/components/Card';
import { BarChart } from '@/components/BarChart';
import { StatusDot } from '@/components/StatusDot';
import { Badge } from '@/components/Badge';
import { LogViewer } from '@/components/LogViewer';
import { UptimeTimeline } from '@/components/UptimeTimeline';
import { Tabs } from '@/components/Tabs';
import { fmtBytes, fmtDurationMs } from '@/lib/formatters';
import { BackLink } from '@/components/BackLink';
import { ActionResult } from '@/components/ActionResult';
import { LoadingState } from '@/components/LoadingState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useContainerAction } from '@/hooks/useContainerAction';
import { useConfirm } from '@/hooks/useConfirm';
import { useTab } from '@/hooks/useTab';
import { MetricGauge } from './MetricGauge';
import { getAnalogy } from '@/lib/analogies';
import { ContainerHistoryTab } from './ContainerHistoryTab';

export function ContainerDetailPage() {
  const { hostId, containerName } = useParams();
  const hid = encodeURIComponent(hostId!);
  const cname = encodeURIComponent(containerName!);
  const { isAuthenticated } = useAuth();
  const { activeTab, setActiveTab } = useTab('overview');
  const [showSnapshots, setShowSnapshots] = useState(false);
  const navigate = useNavigate();
  const { confirm, dialogProps } = useConfirm();
  const { actionLoading, actionResult, runAction, removeContainer } = useContainerAction(hostId!, [['container', hostId, containerName]], confirm);

  const { data } = useQuery({
    queryKey: ['container', hostId, containerName],
    queryFn: () => api<ContainerDetail>(`/hosts/${hid}/containers/${cname}`),
    refetchInterval: 30_000,
  });
  const { data: availability } = useQuery({
    queryKey: ['container-availability', hostId, containerName],
    queryFn: () => api<ContainerAvailability>(`/hosts/${hid}/containers/${cname}/availability?days=7`),
  });
  const entityId = encodeURIComponent(`${hostId}/${containerName}`);
  const { data: baselines, isFetched: baselinesReady } = useQuery({
    queryKey: ['baselines', 'container', hostId, containerName],
    queryFn: () => api<BaselineRow[]>(`/baselines/container/${entityId}`).catch(() => []),
    refetchInterval: false,
  });

  if (!data) return <LoadingState />;

  const findBl = (metric: string): Baseline | null => {
    if (!baselines) return null;
    const row = baselines.find(b => b.metric === metric && b.time_bucket === 'all');
    if (!row || row.p50 == null) return null;
    return { p50: row.p50, p75: row.p75, p90: row.p90, p95: row.p95, p99: row.p99 };
  };

  const history = data.history || [];

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

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'logs', label: 'Logs' },
    { id: 'history', label: 'History', count: data.alerts.length },
  ];

  return (
    <div className="space-y-6">
      <BackLink to={`/hosts/${hid}`} label={`Back to ${hostId}`} />

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <StatusDot status={data.status} size="lg" />
          <h1 className="text-xl font-bold text-fg">{data.container_name}</h1>
        </div>
        {isAuthenticated && (
          <div className="flex items-center gap-2">
            {data.status !== 'running' && (
              <>
                <button onClick={() => runAction(containerName!, 'start', false)} disabled={actionLoading != null}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium text-white transition-colors bg-slate-700 hover:bg-slate-600 ${actionLoading != null ? 'opacity-50 cursor-not-allowed' : ''}`}>
                  {actionLoading === `${containerName}:start` ? 'Starting...' : 'Start'}
                </button>
                <button onClick={async () => { if (await removeContainer(containerName!)) navigate(`/hosts/${hid}`); }} disabled={actionLoading != null}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium text-white transition-colors bg-red-600 hover:bg-red-700 ${actionLoading != null ? 'opacity-50 cursor-not-allowed' : ''}`}>
                  {actionLoading === `${containerName}:remove` ? 'Removing...' : 'Remove'}
                </button>
              </>
            )}
            {data.status === 'running' && (
              <>
                <button onClick={() => runAction(containerName!, 'restart')} disabled={actionLoading != null}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium text-white transition-colors bg-slate-700 hover:bg-slate-600 ${actionLoading != null ? 'opacity-50 cursor-not-allowed' : ''}`}>
                  {actionLoading === `${containerName}:restart` ? 'Restarting...' : 'Restart'}
                </button>
                <button onClick={() => runAction(containerName!, 'stop')} disabled={actionLoading != null}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium text-white transition-colors bg-red-600 hover:bg-red-700 ${actionLoading != null ? 'opacity-50 cursor-not-allowed' : ''}`}>
                  {actionLoading === `${containerName}:stop` ? 'Stopping...' : 'Stop'}
                </button>
              </>
            )}
          </div>
        )}
      </div>
      <ActionResult result={actionResult} />

      <Tabs tabs={tabs} active={activeTab} onChange={setActiveTab} />

      {/* Overview Tab */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          {/* Compact status line */}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl px-4 py-3 bg-surface border border-border">
            <span className="flex items-center gap-2 text-sm">
              <StatusDot status={data.status} />
              <span className={`font-semibold ${data.status === 'running' ? 'text-success' : 'text-danger'}`}>{data.status}</span>
            </span>
            <span className="text-muted">&middot;</span>
            <span className="text-sm">{healthBadge}</span>
            <span className="text-muted">&middot;</span>
            <span className="text-sm">
              <span className="text-muted">Uptime</span>{' '}
              <span className={`font-semibold ${uptimePct != null && uptimePct >= 99 ? 'text-success' : uptimePct != null && uptimePct >= 95 ? 'text-warning' : 'text-danger'}`}>
                {uptimePct != null ? `${uptimePct}%` : '-'}
              </span>
            </span>
            <span className="text-muted">&middot;</span>
            <span className="text-sm">
              <span className="text-muted">Restarts</span>{' '}
              <span className={`font-semibold ${restartDelta > 0 ? 'text-warning' : 'text-fg'}`}>{restartDelta}</span>
            </span>
          </div>

          {/* CPU & Memory gauges */}
          <div className="grid gap-4 md:grid-cols-2">
            <MetricGauge label="CPU" current={data.cpu_percent} avg={avgCpu} peak={maxCpu} unit="%" max={100} analogy={baselinesReady ? getAnalogy('cpu', data.cpu_percent, null, findBl('cpu_percent')) : null} />
            <MetricGauge label="Memory" current={data.memory_mb != null ? Math.round(data.memory_mb) : null} avg={avgMem} peak={maxMem} unit=" MB" max={maxMem != null ? Math.round(maxMem * 1.3) : 512} analogy={baselinesReady ? getAnalogy('memory', data.memory_mb, maxMem != null ? maxMem * 1.3 : 512, findBl('memory_mb')) : null} />
          </div>

          {/* Compact I/O row */}
          {(data.network_rx_bytes != null || data.blkio_read_bytes != null) && (
            <div className="flex flex-wrap gap-x-5 gap-y-1 rounded-xl px-4 py-3 text-xs bg-surface border border-border text-muted">
              {data.network_rx_bytes != null && <span>Net RX <span className="font-semibold text-fg">{fmtBytes(data.network_rx_bytes)}</span></span>}
              {data.network_tx_bytes != null && <span>Net TX <span className="font-semibold text-fg">{fmtBytes(data.network_tx_bytes)}</span></span>}
              {data.blkio_read_bytes != null && <span>Disk Read <span className="font-semibold text-fg">{fmtBytes(data.blkio_read_bytes)}</span></span>}
              {data.blkio_write_bytes != null && <span>Disk Write <span className="font-semibold text-fg">{fmtBytes(data.blkio_write_bytes)}</span></span>}
            </div>
          )}

          {availability && (
            <Card title="Availability (7 days)">
              <div className="space-y-4">
                <div className="flex items-center gap-4">
                  <span className={`text-3xl font-bold ${
                    availability.summary.uptimePercent == null ? 'text-muted'
                      : availability.summary.uptimePercent >= 99 ? 'text-success'
                      : availability.summary.uptimePercent >= 95 ? 'text-warning'
                      : 'text-danger'
                  }`}>
                    {availability.summary.uptimePercent != null ? `${availability.summary.uptimePercent}%` : 'N/A'}
                  </span>
                  <span className="text-sm text-muted">uptime over 7 days</span>
                </div>

                <UptimeTimeline
                  containers={[{
                    name: containerName!,
                    slots: availability.timeline.slots,
                    uptimePercent: availability.timeline.uptimePercent,
                  }]}
                />

                <div className="flex gap-4 text-xs text-muted">
                  <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-success" />{availability.summary.upHours}h up</span>
                  <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-danger" />{availability.summary.downHours}h down</span>
                  <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-border opacity-50" />{availability.summary.noDataHours}h no data</span>
                  <span>of {availability.summary.totalHours}h total</span>
                </div>

                {availability.incidents.length > 0 && (
                  <div>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-secondary">
                      Downtime Incidents
                    </h3>
                    <div className="space-y-1.5">
                      {availability.incidents.map((inc, i) => (
                        <div key={i} className="flex items-center gap-3 text-sm">
                          <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" />
                          <span className="text-secondary">
                            {inc.ongoing ? 'Down since ' : ''}
                            {new Date(inc.start + 'Z').toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                            {inc.end && ` \u2192 ${new Date(inc.end + 'Z').toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`}
                          </span>
                          <span className={`text-xs font-medium ${inc.ongoing ? 'text-danger' : 'text-muted'}`}>
                            {inc.ongoing ? 'ongoing' : inc.durationMs != null ? fmtDurationMs(inc.durationMs) : ''}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {availability.incidents.length === 0 && availability.summary.downHours === 0 && (
                  <p className="text-xs text-muted">No downtime incidents in the last 7 days.</p>
                )}
              </div>
            </Card>
          )}

          {cpuValues.length > 1 && (
            <Card title="CPU (last 24h)">
              <BarChart values={cpuValues} minLabel="0%" maxLabel={`${Math.max(...cpuValues).toFixed(0)}%`} />
            </Card>
          )}

          {memValues.length > 1 && (
            <Card title="Memory (last 24h)">
              <BarChart values={memValues} colorFn={() => 'var(--color-info)'} minLabel="0 MB" maxLabel={`${Math.max(...memValues).toFixed(0)} MB`} />
            </Card>
          )}
        </div>
      )}

      {/* Logs Tab */}
      {activeTab === 'logs' && (
        <Card title="Logs">
          <LogViewer hostId={hostId!} containerName={containerName!} />
        </Card>
      )}

      {/* History Tab */}
      {activeTab === 'history' && (
        <ContainerHistoryTab
          alerts={data.alerts}
          history={history}
          showSnapshots={showSnapshots}
          setShowSnapshots={setShowSnapshots}
        />
      )}

      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
