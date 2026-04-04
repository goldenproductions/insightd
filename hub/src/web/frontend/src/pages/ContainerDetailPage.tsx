import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiAuth } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import type { ContainerDetail, ContainerAvailability, ContainerActionResult } from '@/types/api';
import { Card } from '@/components/Card';
import { BarChart } from '@/components/BarChart';
import { DataTable, type Column } from '@/components/DataTable';
import { StatusDot } from '@/components/StatusDot';
import { Badge } from '@/components/Badge';
import { LogViewer } from '@/components/LogViewer';
import { UptimeTimeline } from '@/components/UptimeTimeline';
import { Tabs } from '@/components/Tabs';
import { timeAgo, fmtBytes, fmtPercent, fmtDurationMs } from '@/lib/formatters';

export function ContainerDetailPage() {
  const { hostId, containerName } = useParams();
  const hid = encodeURIComponent(hostId!);
  const cname = encodeURIComponent(containerName!);
  const { isAuthenticated, token } = useAuth();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState('overview');
  const [showSnapshots, setShowSnapshots] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<{ ok: boolean; message: string } | null>(null);

  const { data } = useQuery({
    queryKey: ['container', hostId, containerName],
    queryFn: () => api<ContainerDetail>(`/hosts/${hid}/containers/${cname}`),
  });
  const { data: availability } = useQuery({
    queryKey: ['container-availability', hostId, containerName],
    queryFn: () => api<ContainerAvailability>(`/hosts/${hid}/containers/${cname}/availability?days=7`),
  });

  if (!data) return <div className="py-12 text-center text-sm" style={{ color: 'var(--text-muted)' }}>Loading...</div>;

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

  const historyCols: Column<typeof history[number]>[] = [
    { header: 'Time', accessor: r => timeAgo(r.collected_at) },
    { header: 'Status', accessor: r => <span className="flex items-center gap-2"><StatusDot status={r.status} />{r.status}</span> },
    { header: 'CPU', accessor: r => fmtPercent(r.cpu_percent) },
    { header: 'Memory', accessor: r => r.memory_mb != null ? `${Math.round(r.memory_mb)} MB` : '-' },
    { header: 'Restarts', accessor: r => r.restart_count },
  ];

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'logs', label: 'Logs' },
    { id: 'history', label: 'History', count: data.alerts.length },
  ];

  return (
    <div className="space-y-6">
      <Link to={`/hosts/${hid}`} className="text-sm text-blue-500 hover:underline">&larr; Back to {hostId}</Link>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <StatusDot status={data.status} size="lg" />
          <h1 className="text-xl font-bold" style={{ color: 'var(--text)' }}>{data.container_name}</h1>
        </div>
        {isAuthenticated && (
          <div className="flex items-center gap-2">
            {data.status !== 'running' && (
              <ActionButton label="Start" action="start" hostId={hid} containerName={cname} token={token}
                loading={actionLoading} setLoading={setActionLoading} setResult={setActionResult}
                onSuccess={() => queryClient.invalidateQueries({ queryKey: ['container', hostId, containerName] })} />
            )}
            {data.status === 'running' && (
              <>
                <ActionButton label="Restart" action="restart" hostId={hid} containerName={cname} token={token} confirm
                  loading={actionLoading} setLoading={setActionLoading} setResult={setActionResult}
                  onSuccess={() => queryClient.invalidateQueries({ queryKey: ['container', hostId, containerName] })} />
                <ActionButton label="Stop" action="stop" hostId={hid} containerName={cname} token={token} confirm danger
                  loading={actionLoading} setLoading={setActionLoading} setResult={setActionResult}
                  onSuccess={() => queryClient.invalidateQueries({ queryKey: ['container', hostId, containerName] })} />
              </>
            )}
          </div>
        )}
      </div>
      {actionResult && (
        <div className="rounded-lg px-3 py-2 text-sm" style={{
          backgroundColor: actionResult.ok ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)',
          color: actionResult.ok ? 'var(--color-success)' : 'var(--color-danger)',
        }}>
          {actionResult.message}
        </div>
      )}

      <Tabs tabs={tabs} active={activeTab} onChange={setActiveTab} />

      {/* Overview Tab */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          {/* Compact status line */}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl px-4 py-3"
            style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}>
            <span className="flex items-center gap-2 text-sm">
              <StatusDot status={data.status} />
              <span className="font-semibold" style={{ color: data.status === 'running' ? 'var(--color-success)' : 'var(--color-danger)' }}>{data.status}</span>
            </span>
            <span style={{ color: 'var(--text-muted)' }}>&middot;</span>
            <span className="text-sm">{healthBadge}</span>
            <span style={{ color: 'var(--text-muted)' }}>&middot;</span>
            <span className="text-sm">
              <span style={{ color: 'var(--text-muted)' }}>Uptime</span>{' '}
              <span className="font-semibold" style={{ color: uptimePct != null && uptimePct >= 99 ? 'var(--color-success)' : uptimePct != null && uptimePct >= 95 ? 'var(--color-warning)' : 'var(--color-danger)' }}>
                {uptimePct != null ? `${uptimePct}%` : '-'}
              </span>
            </span>
            <span style={{ color: 'var(--text-muted)' }}>&middot;</span>
            <span className="text-sm">
              <span style={{ color: 'var(--text-muted)' }}>Restarts</span>{' '}
              <span className="font-semibold" style={{ color: restartDelta > 0 ? 'var(--color-warning)' : 'var(--text)' }}>{restartDelta}</span>
            </span>
          </div>

          {/* CPU & Memory gauges */}
          <div className="grid gap-4 md:grid-cols-2">
            <MetricGauge label="CPU" current={data.cpu_percent} avg={avgCpu} peak={maxCpu} unit="%" max={100} />
            <MetricGauge label="Memory" current={data.memory_mb != null ? Math.round(data.memory_mb) : null} avg={avgMem} peak={maxMem} unit=" MB" max={maxMem != null ? Math.round(maxMem * 1.3) : 512} />
          </div>

          {/* Compact I/O row */}
          {(data.network_rx_bytes != null || data.blkio_read_bytes != null) && (
            <div className="flex flex-wrap gap-x-5 gap-y-1 rounded-xl px-4 py-3 text-xs"
              style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}>
              {data.network_rx_bytes != null && <span>Net RX <span className="font-semibold" style={{ color: 'var(--text)' }}>{fmtBytes(data.network_rx_bytes)}</span></span>}
              {data.network_tx_bytes != null && <span>Net TX <span className="font-semibold" style={{ color: 'var(--text)' }}>{fmtBytes(data.network_tx_bytes)}</span></span>}
              {data.blkio_read_bytes != null && <span>Disk Read <span className="font-semibold" style={{ color: 'var(--text)' }}>{fmtBytes(data.blkio_read_bytes)}</span></span>}
              {data.blkio_write_bytes != null && <span>Disk Write <span className="font-semibold" style={{ color: 'var(--text)' }}>{fmtBytes(data.blkio_write_bytes)}</span></span>}
            </div>
          )}

          {availability && (
            <Card title="Availability (7 days)">
              <div className="space-y-4">
                <div className="flex items-center gap-4">
                  <span className="text-3xl font-bold" style={{
                    color: availability.summary.uptimePercent == null ? 'var(--text-muted)'
                      : availability.summary.uptimePercent >= 99 ? 'var(--color-success)'
                      : availability.summary.uptimePercent >= 95 ? 'var(--color-warning)'
                      : 'var(--color-danger)'
                  }}>
                    {availability.summary.uptimePercent != null ? `${availability.summary.uptimePercent}%` : 'N/A'}
                  </span>
                  <span className="text-sm" style={{ color: 'var(--text-muted)' }}>uptime over 7 days</span>
                </div>

                <UptimeTimeline
                  containers={[{
                    name: containerName!,
                    slots: availability.timeline.slots,
                    uptimePercent: availability.timeline.uptimePercent,
                  }]}
                />

                <div className="flex gap-4 text-xs" style={{ color: 'var(--text-muted)' }}>
                  <span><span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ backgroundColor: 'var(--color-success)' }} />{availability.summary.upHours}h up</span>
                  <span><span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ backgroundColor: 'var(--color-danger)' }} />{availability.summary.downHours}h down</span>
                  <span><span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ backgroundColor: 'var(--border)', opacity: 0.5 }} />{availability.summary.noDataHours}h no data</span>
                  <span>of {availability.summary.totalHours}h total</span>
                </div>

                {availability.incidents.length > 0 && (
                  <div>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
                      Downtime Incidents
                    </h3>
                    <div className="space-y-1.5">
                      {availability.incidents.map((inc, i) => (
                        <div key={i} className="flex items-center gap-3 text-sm">
                          <span className="h-2 w-2 flex-shrink-0 rounded-full bg-red-500" />
                          <span style={{ color: 'var(--text-secondary)' }}>
                            {inc.ongoing ? 'Down since ' : ''}
                            {new Date(inc.start + 'Z').toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                            {inc.end && ` \u2192 ${new Date(inc.end + 'Z').toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`}
                          </span>
                          <span className="text-xs font-medium" style={{ color: inc.ongoing ? 'var(--color-danger)' : 'var(--text-muted)' }}>
                            {inc.ongoing ? 'ongoing' : inc.durationMs != null ? fmtDurationMs(inc.durationMs) : ''}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {availability.incidents.length === 0 && availability.summary.downHours === 0 && (
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>No downtime incidents in the last 7 days.</p>
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
        <div className="space-y-6">
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

          <HistorySummary history={history} />

          <div>
            <button
              onClick={() => setShowSnapshots(!showSnapshots)}
              className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium hover-surface"
              style={{ color: 'var(--text-secondary)', backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}
            >
              <span style={{ fontSize: '0.6rem' }}>{showSnapshots ? '\u25BC' : '\u25B6'}</span>
              {showSnapshots ? 'Hide' : 'Show'} all snapshots ({history.length})
            </button>
            {showSnapshots && (
              <div className="mt-3">
                <Card>
                  <DataTable columns={historyCols} data={[...history].reverse()} emptyText="No history data" />
                </Card>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function HistorySummary({ history }: { history: ContainerDetail['history'] }) {
  if (history.length === 0) return null;

  // Time range
  const oldest = history[0]!.collected_at;
  const newest = history[history.length - 1]!.collected_at;
  const rangeMs = new Date(newest + 'Z').getTime() - new Date(oldest + 'Z').getTime();
  const rangeLabel = rangeMs > 86400000 ? `${Math.round(rangeMs / 86400000)}d` : `${Math.round(rangeMs / 3600000)}h`;

  // Status changes
  const statusChanges: { time: string; from: string; to: string }[] = [];
  for (let i = 1; i < history.length; i++) {
    if (history[i]!.status !== history[i - 1]!.status) {
      statusChanges.push({ time: history[i]!.collected_at, from: history[i - 1]!.status, to: history[i]!.status });
    }
  }

  // Restart bumps
  const restartEvents: { time: string; delta: number }[] = [];
  for (let i = 1; i < history.length; i++) {
    const diff = history[i]!.restart_count - history[i - 1]!.restart_count;
    if (diff > 0) {
      restartEvents.push({ time: history[i]!.collected_at, delta: diff });
    }
  }

  // Combine events sorted newest first
  const events = [
    ...statusChanges.map(e => ({
      time: e.time,
      good: e.to === 'running',
      message: e.to === 'running' ? `Started (was ${e.from})` : `Stopped (${e.to})`,
    })),
    ...restartEvents.map(e => ({
      time: e.time,
      good: false,
      message: `Restarted${e.delta > 1 ? ` (${e.delta}x)` : ''}`,
    })),
  ].sort((a, b) => b.time.localeCompare(a.time));

  return (
    <Card title="History Summary">
      <div className="space-y-4">
        {/* Summary stats */}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs" style={{ color: 'var(--text-muted)' }}>
          <span><span className="font-semibold" style={{ color: 'var(--text)' }}>{history.length}</span> snapshots</span>
          <span><span className="font-semibold" style={{ color: 'var(--text)' }}>{rangeLabel}</span> time range</span>
          <span><span className="font-semibold" style={{ color: statusChanges.length > 0 ? 'var(--color-warning)' : 'var(--text)' }}>{statusChanges.length}</span> status changes</span>
          <span><span className="font-semibold" style={{ color: restartEvents.length > 0 ? 'var(--color-warning)' : 'var(--text)' }}>{restartEvents.length}</span> restarts</span>
        </div>

        {/* Status strip — sampled to max 120 blocks */}
        <div>
          <div className="mb-1 text-xs" style={{ color: 'var(--text-muted)' }}>Status over time</div>
          <div className="flex gap-px overflow-hidden" style={{ height: 12 }}>
            {(() => {
              const maxBars = 120;
              const bucketSize = Math.max(1, Math.ceil(history.length / maxBars));
              const buckets: { status: string; time: string }[] = [];
              for (let i = 0; i < history.length; i += bucketSize) {
                const slice = history.slice(i, i + bucketSize);
                const anyDown = slice.some(s => s.status !== 'running');
                const mid = slice[Math.floor(slice.length / 2)]!;
                buckets.push({ status: anyDown ? 'down' : 'running', time: mid.collected_at });
              }
              return buckets.map((b, i) => (
                <div
                  key={i}
                  className="flex-1 rounded-sm first:rounded-l last:rounded-r"
                  style={{
                    backgroundColor: b.status === 'running' ? 'var(--color-success)' : 'var(--color-danger)',
                    minWidth: 2,
                  }}
                  title={`${b.status} — ${new Date(b.time + 'Z').toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`}
                />
              ));
            })()}
          </div>
          <div className="mt-1 flex justify-between text-[10px]" style={{ color: 'var(--text-muted)' }}>
            <span>{timeAgo(oldest)}</span>
            <span>{timeAgo(newest)}</span>
          </div>
        </div>

        {/* Key events */}
        {events.length > 0 ? (
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
              Key Events
            </div>
            <div className="space-y-1.5">
              {events.slice(0, 20).map((e, i) => (
                <div key={i} className="flex items-center gap-3 text-sm">
                  <span className={`h-2 w-2 flex-shrink-0 rounded-full ${e.good ? 'bg-emerald-500' : 'bg-red-500'}`} />
                  <span className="text-xs" style={{ color: 'var(--text-muted)', minWidth: '4rem' }}>{timeAgo(e.time)}</span>
                  <span style={{ color: 'var(--text-secondary)' }}>{e.message}</span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>No status changes or restarts in this period.</p>
        )}
      </div>
    </Card>
  );
}

function MetricGauge({ label, current, avg, peak, unit, max }: {
  label: string; current: number | null; avg: number | null; peak: number | null; unit: string; max: number;
}) {
  const pct = current != null ? Math.min(100, Math.round((current / max) * 100)) : 0;
  const avgPct = avg != null ? Math.min(100, Math.round((avg / max) * 100)) : null;
  const color = pct > 90 ? 'var(--color-danger)' : pct > 70 ? 'var(--color-warning)' : 'var(--color-success)';

  return (
    <div className="rounded-xl p-4" style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}>
      <div className="mb-3 flex items-baseline justify-between">
        <span className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>{label}</span>
        <span className="text-2xl font-bold" style={{ color }}>
          {current != null ? `${current}${unit}` : '-'}
        </span>
      </div>
      <div className="relative h-3 w-full rounded-full" style={{ backgroundColor: 'var(--border)' }}>
        <div className="h-3 rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: color }} />
        {avgPct != null && (
          <div className="absolute top-0 h-3 w-0.5" style={{ left: `${avgPct}%`, backgroundColor: 'var(--text-muted)', opacity: 0.6 }}
            title={`avg ${avg}${unit}`} />
        )}
      </div>
      <div className="mt-2 flex gap-4 text-xs" style={{ color: 'var(--text-muted)' }}>
        <span>avg <span className="font-medium" style={{ color: 'var(--text-secondary)' }}>{avg != null ? `${avg}${unit}` : '-'}</span></span>
        <span>peak <span className="font-medium" style={{ color: 'var(--text-secondary)' }}>{peak != null ? `${peak}${unit}` : '-'}</span></span>
      </div>
    </div>
  );
}

function ActionButton({ label, action, hostId, containerName, token, confirm: needsConfirm, danger, loading, setLoading, setResult, onSuccess }: {
  label: string; action: string; hostId: string; containerName: string; token: string | null;
  confirm?: boolean; danger?: boolean;
  loading: string | null; setLoading: (v: string | null) => void;
  setResult: (v: { ok: boolean; message: string } | null) => void; onSuccess: () => void;
}) {
  const run = async () => {
    if (needsConfirm && !window.confirm(`${label} container "${decodeURIComponent(containerName)}"?`)) return;
    setLoading(action);
    setResult(null);
    try {
      const res = await apiAuth('POST', `/hosts/${hostId}/containers/${containerName}/action`, { action }, token) as ContainerActionResult;
      setResult({ ok: res.status === 'success', message: res.message || res.error || `${label} completed` });
      if (res.status === 'success') onSuccess();
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : 'Action failed' });
    } finally {
      setLoading(null);
    }
  };

  return (
    <button onClick={run} disabled={loading != null}
      className={`rounded-lg px-3 py-1.5 text-xs font-medium text-white transition-colors ${danger ? 'bg-red-600 hover:bg-red-700' : 'bg-slate-700 hover:bg-slate-600'} ${loading != null ? 'opacity-50 cursor-not-allowed' : ''}`}>
      {loading === action ? `${label}ing...` : label}
    </button>
  );
}
