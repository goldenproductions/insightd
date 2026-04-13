import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import type { ContainerDetail, ContainerAvailability, BaselineRow, ContainerSnapshot } from '@/types/api';
import { Card } from '@/components/Card';
import { Button } from '@/components/FormField';
import { BarChart } from '@/components/BarChart';
import { StatusDot } from '@/components/StatusDot';
import { Badge } from '@/components/Badge';
import { LogViewer } from '@/components/LogViewer';
import { UptimeTimeline } from '@/components/UptimeTimeline';
import { Tabs } from '@/components/Tabs';
import { fmtDurationMs } from '@/lib/formatters';
import { BackLink } from '@/components/BackLink';
import { ActionResult } from '@/components/ActionResult';
import { CardSkeleton } from '@/components/Skeleton';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useContainerAction } from '@/hooks/useContainerAction';
import { useConfirm } from '@/hooks/useConfirm';
import { useKeyboardShortcut } from '@/hooks/useKeyboardShortcut';
import { MetricGauge } from './MetricGauge';
import { getAnalogy, findBaseline } from '@/lib/analogies';
import { ContainerHistoryTab } from './ContainerHistoryTab';
import { FindingCard } from '@/components/FindingCard';
import { AIDiagnosisCard } from '@/components/AIDiagnosisCard';
import { queryKeys } from '@/lib/queryKeys';

export function ContainerDetailPage() {
  const { hostId, containerName } = useParams();
  const hid = encodeURIComponent(hostId!);
  const cname = encodeURIComponent(containerName!);
  const { isAuthenticated } = useAuth();
  const [activeTab, setActiveTab] = useState('overview');
  const [showCharts, setShowCharts] = useState(true);
  const navigate = useNavigate();
  const { confirm, dialogProps } = useConfirm();
  const { actionLoading, actionResult, runAction, removeContainer } = useContainerAction(hostId!, [['container', hostId, containerName]], confirm);

  const { data, error, isLoading } = useQuery({
    queryKey: queryKeys.container(hostId, containerName),
    queryFn: () => api<ContainerDetail>(`/hosts/${hid}/containers/${cname}`),
    refetchInterval: 30_000,
  });
  const { data: availability } = useQuery({
    queryKey: queryKeys.containerAvailability(hostId, containerName),
    queryFn: () => api<ContainerAvailability>(`/hosts/${hid}/containers/${cname}/availability?days=7`),
  });
  const entityId = encodeURIComponent(`${hostId}/${containerName}`);
  const { data: baselines, isFetched: baselinesReady } = useQuery({
    queryKey: queryKeys.containerBaselines(hostId, containerName),
    queryFn: () => api<BaselineRow[]>(`/baselines/container/${entityId}`).catch(() => []),
    refetchInterval: false,
  });
  const { data: siblings } = useQuery({
    queryKey: queryKeys.hostContainers(hostId),
    queryFn: () => api<ContainerSnapshot[]>(`/hosts/${hid}/containers`),
    staleTime: 30_000,
  });

  // Prev/next sibling navigation. Server-orders alphabetically by container_name,
  // matching the host page's render order so users aren't disoriented.
  const siblingNames = siblings?.map(c => c.container_name) ?? [];
  const currentIdx = containerName ? siblingNames.indexOf(containerName) : -1;
  const prevName = currentIdx > 0 ? siblingNames[currentIdx - 1] : null;
  const nextName = currentIdx >= 0 && currentIdx < siblingNames.length - 1 ? siblingNames[currentIdx + 1] : null;
  const goToSibling = (name: string) => navigate(`/hosts/${hid}/containers/${encodeURIComponent(name)}`);

  // Keyboard shortcuts — registered unconditionally (Rules of Hooks); callbacks
  // read the latest `data` via the ref-wrapped trigger inside useKeyboardShortcut.
  const isRunning = data?.status === 'running';
  const canControl = isAuthenticated && isRunning;
  useKeyboardShortcut({
    keys: 'r',
    description: 'Restart container',
    scope: 'Container detail',
    disabled: !canControl,
    onTrigger: () => { if (containerName) runAction(containerName, 'restart'); },
  });
  useKeyboardShortcut({
    keys: 's',
    description: 'Stop container',
    scope: 'Container detail',
    disabled: !canControl,
    onTrigger: () => { if (containerName) runAction(containerName, 'stop'); },
  });
  useKeyboardShortcut({
    keys: '1',
    description: 'Overview tab',
    scope: 'Container detail',
    onTrigger: () => setActiveTab('overview'),
  });
  useKeyboardShortcut({
    keys: '2',
    description: 'Logs tab',
    scope: 'Container detail',
    onTrigger: () => setActiveTab('logs'),
  });
  useKeyboardShortcut({
    keys: '3',
    description: 'Alerts & history tab',
    scope: 'Container detail',
    onTrigger: () => setActiveTab('history'),
  });
  useKeyboardShortcut({
    keys: 'b',
    description: 'Back to host',
    scope: 'Container detail',
    onTrigger: () => navigate(`/hosts/${hid}`),
  });
  useKeyboardShortcut({
    keys: '[',
    description: 'Previous container',
    scope: 'Container detail',
    disabled: !prevName,
    onTrigger: () => { if (prevName) goToSibling(prevName); },
  });
  useKeyboardShortcut({
    keys: ']',
    description: 'Next container',
    scope: 'Container detail',
    disabled: !nextName,
    onTrigger: () => { if (nextName) goToSibling(nextName); },
  });

  if (error) return (
    <div className="space-y-4">
      <BackLink to={`/hosts/${hid}`} label={`Back to ${hostId}`} />
      <Card title="Container not found">
        <p className="text-sm text-muted">
          No data found for <span className="font-semibold text-fg">{containerName}</span> on {hostId}.
          The container may have been removed or hasn't reported any metrics yet.
        </p>
      </Card>
    </div>
  );

  if (isLoading || !data) return (
    <div className="space-y-6">
      <div className="h-4 w-32 animate-pulse rounded bg-border" />
      <div className="h-7 w-48 animate-pulse rounded bg-border" />
      <div className="h-12 animate-pulse rounded-xl bg-border" />
      <div className="grid gap-4 md:grid-cols-2">
        <CardSkeleton lines={2} />
        <CardSkeleton lines={2} />
      </div>
    </div>
  );

  const findBl = (metric: string) => findBaseline(baselines, metric);

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

  const showHealthFailure = data.health_status === 'unhealthy';

  const healthPillText = data.health_status === 'healthy'
    ? 'health probe ok'
    : data.health_status === 'unhealthy'
    ? 'health probe failing'
    : data.health_status ?? null;
  const healthPillColor: 'green' | 'red' | 'yellow' = data.health_status === 'healthy'
    ? 'green'
    : data.health_status === 'unhealthy'
    ? 'red'
    : 'yellow';

  const tabs = [
    { id: 'overview', label: 'Overview', shortcut: '1' },
    { id: 'logs', label: 'Logs', shortcut: '2' },
    { id: 'history', label: 'Alerts & history', count: data.alerts.length, shortcut: '3' },
  ];

  return (
    <div className="animate-fade-in space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <BackLink to={`/hosts/${hid}`} label={`Back to ${hostId}`} />
        {(prevName || nextName) && (
          <div className="flex items-center gap-1 text-xs">
            <button
              type="button"
              onClick={() => prevName && goToSibling(prevName)}
              disabled={!prevName}
              title={prevName ? `Previous: ${prevName} ([)` : 'No previous container'}
              className="rounded px-2 py-1 text-muted transition-colors hover:bg-bg-secondary hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted"
            >
              ← {prevName ?? '—'}
            </button>
            <span className="px-1 text-[10px] text-muted">{currentIdx >= 0 && siblingNames.length > 0 ? `${currentIdx + 1}/${siblingNames.length}` : ''}</span>
            <button
              type="button"
              onClick={() => nextName && goToSibling(nextName)}
              disabled={!nextName}
              title={nextName ? `Next: ${nextName} (])` : 'No next container'}
              className="rounded px-2 py-1 text-muted transition-colors hover:bg-bg-secondary hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted"
            >
              {nextName ?? '—'} →
            </button>
          </div>
        )}
      </div>

      {/* ═══ HERO LAYER ═══
          Identity, live status, and (when things are wrong) the diagnosis that
          demands attention. Always visible, regardless of active tab. */}
      <section className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <StatusDot status={data.status} size="lg" />
            <h1 className="truncate text-xl font-bold text-fg">{data.container_name}</h1>
          </div>
          {isAuthenticated && (
            <div className="flex shrink-0 items-center gap-2">
              {data.status !== 'running' && (
                <>
                  <Button variant="ghost" size="sm" onClick={() => runAction(containerName!, 'start', false)} disabled={actionLoading != null}>
                    {actionLoading === `${containerName}:start` ? 'Starting…' : 'Start'}
                  </Button>
                  <Button variant="danger" size="sm" onClick={async () => { if (await removeContainer(containerName!)) navigate(`/hosts/${hid}`); }} disabled={actionLoading != null}>
                    {actionLoading === `${containerName}:remove` ? 'Removing…' : 'Remove'}
                  </Button>
                </>
              )}
              {data.status === 'running' && (
                <>
                  <Button variant="ghost" size="sm" title="Restart (r)" onClick={() => runAction(containerName!, 'restart')} disabled={actionLoading != null}>
                    {actionLoading === `${containerName}:restart` ? 'Restarting…' : 'Restart'}
                  </Button>
                  <Button variant="danger" size="sm" title="Stop (s)" onClick={() => runAction(containerName!, 'stop')} disabled={actionLoading != null}>
                    {actionLoading === `${containerName}:stop` ? 'Stopping…' : 'Stop'}
                  </Button>
                </>
              )}
            </div>
          )}
        </div>

        {/* Status pills + compact stats — flat row, no card wrapper */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge text={data.status} color={data.status === 'running' ? 'green' : 'red'} />
            {healthPillText && (
              <span title="Docker runs a health check command inside the container. This is a probe signal — the service may still be responding.">
                <Badge text={healthPillText} color={healthPillColor} />
              </span>
            )}
          </div>
          <span
            className="text-sm"
            title="Percentage of recent history where the container process was running. Not the same as service health."
          >
            <span className="text-muted">Process uptime</span>{' '}
            <span className={`font-semibold ${
              uptimePct == null ? 'text-muted'
                : showHealthFailure ? 'text-fg'
                : uptimePct >= 99 ? 'text-success'
                : uptimePct >= 95 ? 'text-warning'
                : 'text-danger'
            }`}>
              {uptimePct != null ? `${uptimePct}%` : '-'}
            </span>
          </span>
          <span className="text-sm" title="Total restarts observed in the recent history window.">
            <span className="text-muted">Restarts</span>{' '}
            <span className={`font-semibold ${restartDelta > 0 ? 'text-warning' : 'text-fg'}`}>{restartDelta}</span>
          </span>
        </div>

        <ActionResult result={actionResult} />

        {/* Diagnosis lives in the hero when something is wrong — this is the
            "urgent when needed" inversion of the calm-by-default layout. */}
        {showHealthFailure && data.findings && data.findings.length > 0 && (
          <div className="space-y-3">
            {data.findings.map((finding, i) => {
              // When the suggested action tells the user to restart, wire a
              // primary button directly into the finding so the advice and
              // the fix live in the same block — no scroll hunt required.
              const wantsRestart = /restart|reboot|bounce/i.test(finding.suggestedAction ?? '');
              const canRestart = wantsRestart && data.status === 'running' && isAuthenticated;
              const isRestarting = actionLoading === `${containerName}:restart`;
              const primaryAction = canRestart ? {
                label: isRestarting ? 'Restarting…' : 'Restart container',
                onClick: () => runAction(containerName!, 'restart'),
                disabled: actionLoading != null,
                title: 'Restart (r)',
              } : undefined;
              return (
                <FindingCard
                  key={i}
                  finding={finding}
                  technicalDetails={data.health_check_output}
                  liveSnapshot={{
                    status: data.status,
                    healthStatus: data.health_status,
                    cpuPercent: data.cpu_percent,
                    memoryMb: data.memory_mb,
                    restartCount: data.restart_count,
                  }}
                  primaryAction={primaryAction}
                />
              );
            })}
          </div>
        )}
        {/* AI diagnosis in the hero only when something is wrong — pairs with
            the rule-based finding as a secondary opinion. On healthy
            containers it moves to the detail layer so it's still reachable
            without competing with the calm-by-default state. */}
        {showHealthFailure && <AIDiagnosisCard hostId={hostId!} containerName={containerName!} />}
      </section>

      <Tabs tabs={tabs} active={activeTab} onChange={setActiveTab} />

      {/* Overview Tab — Status + Detail layers below the hero */}
      {activeTab === 'overview' && (
        <div className="space-y-8">
          {/* ═══ STATUS LAYER ═══ objective performance signals */}
          <section className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <MetricGauge label="CPU" current={data.cpu_percent} avg={avgCpu} peak={maxCpu} unit="%" max={100} analogy={baselinesReady ? getAnalogy('cpu', data.cpu_percent, null, findBl('cpu_percent')) : null} />
              <MetricGauge label="Memory" current={data.memory_mb != null ? Math.round(data.memory_mb) : null} avg={avgMem} peak={maxMem} unit=" MB" max={maxMem != null ? Math.round(maxMem * 1.3) : 512} analogy={baselinesReady ? getAnalogy('memory', data.memory_mb, maxMem != null ? maxMem * 1.3 : 512, findBl('memory_mb')) : null} />
            </div>

            {availability && (
              <Card title="Process availability (7 days)">
                <div className="space-y-4">
                  <p className="-mt-1 text-[11px] text-muted">
                    Tracks whether the container process was running, not whether its health probe passed.
                  </p>
                  <div className="flex items-center gap-4">
                    <span className={`text-3xl font-bold ${
                      availability.summary.uptimePercent == null ? 'text-muted'
                        : showHealthFailure ? 'text-fg'
                        : availability.summary.uptimePercent >= 99 ? 'text-success'
                        : availability.summary.uptimePercent >= 95 ? 'text-warning'
                        : 'text-danger'
                    }`}>
                      {availability.summary.uptimePercent != null ? `${availability.summary.uptimePercent}%` : 'N/A'}
                    </span>
                    <span className="text-sm text-muted">process running over 7 days</span>
                  </div>
                  {showHealthFailure && (
                    <p className="text-xs text-muted">
                      Process has been running — its health probe is failing. See the diagnosis above.
                    </p>
                  )}

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
                        Downtime incidents
                      </h3>
                      <div className="space-y-1.5">
                        {availability.incidents.map((inc, i) => (
                          <div key={i} className="flex items-center gap-3 text-sm">
                            <span className="h-2 w-2 shrink-0 rounded-full bg-danger" />
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
          </section>

          {/* ═══ DETAIL LAYER ═══ historical depth + power-user options */}
          {(cpuValues.length > 1 || memValues.length > 1 || !showHealthFailure) && (
            <section className="space-y-6">
              {(cpuValues.length > 1 || memValues.length > 1) && (
                <div>
                  <button
                    onClick={() => setShowCharts(!showCharts)}
                    className="mb-3 text-xs font-medium text-muted hover:text-fg transition-colors"
                  >
                    {showCharts ? '▲ Hide charts' : '▼ Show charts'}
                  </button>
                  {showCharts && (
                    <div className="space-y-6">
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
                </div>
              )}

              {/* AI diagnosis on healthy containers — available as a quiet
                  power-user option. On unhealthy containers it lives in the
                  hero alongside the rule-based finding instead. */}
              {!showHealthFailure && <AIDiagnosisCard hostId={hostId!} containerName={containerName!} />}
            </section>
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
          hostId={hostId}
          containerName={containerName}
        />
      )}

      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
