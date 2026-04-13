import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import type { Alert } from '@/types/api';
import { Card } from '@/components/Card';
import { DataTable, type Column } from '@/components/DataTable';
import { StatusDot } from '@/components/StatusDot';
import { AlertSilenceControls } from '@/components/AlertSilenceControls';
import { AlertsFilterToolbar, type TimeRange } from '@/components/AlertsFilterToolbar';
import { timeAgo, fmtDurationMs, formatAlertType } from '@/lib/formatters';
import { PageTitle } from '@/components/PageTitle';

/**
 * Map an alert to the most relevant detail page. Container-scoped alerts
 * link to the container; host-scoped (disk, host CPU/memory/load) link to
 * the host; endpoint alerts link to the endpoint detail page.
 */
function alertLink(alert: Alert): string {
  const hostScoped = ['disk_full', 'high_host_cpu', 'low_host_memory', 'high_load'];
  const endpointScoped = ['endpoint_down'];
  if (hostScoped.includes(alert.alert_type)) {
    return `/hosts/${encodeURIComponent(alert.host_id)}`;
  }
  if (endpointScoped.includes(alert.alert_type)) {
    return `/endpoints`;
  }
  return `/hosts/${encodeURIComponent(alert.host_id)}/containers/${encodeURIComponent(alert.target)}`;
}

const HOST_SCOPED = new Set(['disk_full', 'high_host_cpu', 'low_host_memory', 'high_load', 'endpoint_down']);

function durationBetween(start: string, end: string): string {
  const ms = new Date(end + 'Z').getTime() - new Date(start + 'Z').getTime();
  if (!isFinite(ms) || ms < 0) return '—';
  return fmtDurationMs(ms);
}

const activeColumns: Column<Alert>[] = [
  { header: 'Type', accessor: r => <span className="flex items-center gap-2"><StatusDot status="red" /> {formatAlertType(r.alert_type)}</span> },
  { header: 'Reason', accessor: r => <span className="text-xs text-secondary">{r.message || `${formatAlertType(r.alert_type)} on ${r.target}`}</span>, hideOnMobile: true },
  { header: 'Host', accessor: r => <span className="text-info">{r.host_id}</span> },
  { header: 'Triggered', accessor: r => <span title={r.triggered_at}>{timeAgo(r.triggered_at)}</span> },
  {
    header: 'Reminders',
    headerTooltip: 'How many reminder notifications have been sent. After the first send, reminders slow down — see Settings → Alerts → Slow down reminders.',
    accessor: r => r.notify_count,
    hideOnMobile: true,
  },
  {
    header: 'Actions',
    accessor: r => {
      const isContainerScoped = !HOST_SCOPED.has(r.alert_type);
      return (
        <AlertSilenceControls
          alert={r}
          hostId={isContainerScoped ? r.host_id : undefined}
          containerName={isContainerScoped ? r.target : undefined}
        />
      );
    },
    hideOnMobile: true,
  },
];

const resolvedColumns: Column<Alert>[] = [
  { header: 'Type', accessor: r => <span className="flex items-center gap-2 text-muted"><StatusDot status="green" /> {formatAlertType(r.alert_type)}</span> },
  { header: 'Host', accessor: r => <span className="text-secondary">{r.host_id}</span> },
  { header: 'Triggered', accessor: r => <span className="text-muted" title={r.triggered_at}>{timeAgo(r.triggered_at)}</span> },
  { header: 'Resolved', accessor: r => <span className="text-muted" title={r.resolved_at ?? undefined}>{timeAgo(r.resolved_at!)}</span>, hideOnMobile: true },
  { header: 'Duration', accessor: r => <span className="text-muted">{durationBetween(r.triggered_at, r.resolved_at!)}</span>, hideOnMobile: true },
];

function HeaderSummary({ activeCount, silencedCount, resolvedRecentCount }: { activeCount: number; silencedCount: number; resolvedRecentCount: number }) {
  const activeColor = activeCount > 0 ? 'text-danger' : 'text-success';
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
      <span className={`font-semibold ${activeColor}`}>
        {activeCount === 0 ? 'No active alerts' : `${activeCount} active`}
      </span>
      {silencedCount > 0 && (
        <span className="text-muted">
          🔇 <span className="font-medium text-fg">{silencedCount}</span> silenced
        </span>
      )}
      <span className="text-muted">
        Last 7 days: <span className="font-medium text-fg">{resolvedRecentCount}</span> resolved
      </span>
    </div>
  );
}

const VALID_RANGES: TimeRange[] = ['24h', '7d', '30d', 'all'];

function rangeToMs(range: TimeRange): number | null {
  switch (range) {
    case '24h': return 24 * 60 * 60 * 1000;
    case '7d':  return 7 * 24 * 60 * 60 * 1000;
    case '30d': return 30 * 24 * 60 * 60 * 1000;
    case 'all': return null;
  }
}

export function AlertsPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: alerts } = useQuery({ queryKey: queryKeys.alerts(), queryFn: () => api<Alert[]>('/alerts?active=false'), refetchInterval: 30_000 });

  // URL-driven filter state. Default range = 7d to limit noise on first load.
  const selectedHost = searchParams.get('host');
  const rawRange = searchParams.get('range') as TimeRange | null;
  const timeRange: TimeRange = rawRange && VALID_RANGES.includes(rawRange) ? rawRange : '7d';

  const setHost = (host: string | null) => {
    setSearchParams(prev => {
      const p = new URLSearchParams(prev);
      if (host) p.set('host', host);
      else p.delete('host');
      return p;
    }, { replace: true });
  };

  const setRange = (range: TimeRange) => {
    setSearchParams(prev => {
      const p = new URLSearchParams(prev);
      if (range !== '7d') p.set('range', range);
      else p.delete('range');
      return p;
    }, { replace: true });
  };

  const {
    activeAll, resolvedAll, activeFiltered, resolvedFiltered,
    hosts, silencedCount, resolvedRecentCount, lastResolvedAt,
  } = useMemo(() => {
    const list = alerts ?? [];
    const activeAll: Alert[] = [];
    const resolvedAll: Alert[] = [];
    const hostSet = new Set<string>();
    let silencedCount = 0;
    for (const a of list) {
      hostSet.add(a.host_id);
      if (a.resolved_at == null) {
        activeAll.push(a);
        if (a.silenced_until != null) silencedCount++;
      } else {
        resolvedAll.push(a);
      }
    }

    // Header summary uses pre-filter counts so the user always sees the
    // unfiltered system state regardless of what they're zoomed into.
    const lastResolvedAt = resolvedAll.length > 0 ? resolvedAll[0]!.resolved_at : null;
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const resolvedRecentCount = resolvedAll.filter(r => {
      const t = new Date(r.resolved_at + 'Z').getTime();
      return isFinite(t) && t >= sevenDaysAgo;
    }).length;

    // Apply host filter to both sections, time range filter to resolved only.
    // Active alerts always show regardless of age — they need attention now.
    const matchesHost = (a: Alert) => !selectedHost || a.host_id === selectedHost;
    const activeFiltered = activeAll.filter(matchesHost);

    const rangeMs = rangeToMs(timeRange);
    const cutoff = rangeMs == null ? null : Date.now() - rangeMs;
    const matchesRange = (a: Alert) => {
      if (cutoff == null) return true;
      const t = new Date(a.resolved_at + 'Z').getTime();
      return isFinite(t) && t >= cutoff;
    };
    const resolvedFiltered = resolvedAll.filter(a => matchesHost(a) && matchesRange(a));

    return {
      activeAll, resolvedAll, activeFiltered, resolvedFiltered,
      hosts: Array.from(hostSet).sort(),
      silencedCount, resolvedRecentCount, lastResolvedAt,
    };
  }, [alerts, selectedHost, timeRange]);

  const filterActive = selectedHost != null || timeRange !== '7d';

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <PageTitle>Alerts</PageTitle>
        <HeaderSummary activeCount={activeAll.length} silencedCount={silencedCount} resolvedRecentCount={resolvedRecentCount} />
      </div>

      <AlertsFilterToolbar
        hosts={hosts}
        selectedHost={selectedHost}
        onHostChange={setHost}
        timeRange={timeRange}
        onTimeRangeChange={setRange}
      />

      {/* ═══ ACTIVE LAYER ═══ what needs attention right now */}
      <section className="space-y-3">
        {activeFiltered.length > 0 ? (
          <Card title={
            filterActive && activeFiltered.length !== activeAll.length
              ? `Active · ${activeFiltered.length} of ${activeAll.length} shown`
              : 'Active'
          }>
            <DataTable
              columns={activeColumns}
              data={activeFiltered}
              onRowClick={r => navigate(alertLink(r))}
            />
          </Card>
        ) : (
          <Card title="Active">
            <div className="py-6 text-center">
              <p className="text-sm text-fg">
                {activeAll.length === 0
                  ? 'No active alerts.'
                  : 'No active alerts match the current filter.'}
              </p>
              {activeAll.length === 0 && lastResolvedAt && (
                <p className="mt-1 text-xs text-muted">Last alert resolved {timeAgo(lastResolvedAt)}.</p>
              )}
            </div>
          </Card>
        )}
      </section>

      {/* ═══ RESOLVED LAYER ═══ history, secondary */}
      {resolvedAll.length > 0 && (
        <section className="space-y-3">
          <Card title={
            resolvedFiltered.length === resolvedAll.length
              ? `Recent · ${resolvedAll.length} resolved`
              : `Recent · ${resolvedFiltered.length} of ${resolvedAll.length} resolved shown`
          }>
            {resolvedFiltered.length > 0 ? (
              <DataTable
                columns={resolvedColumns}
                data={resolvedFiltered}
                onRowClick={r => navigate(alertLink(r))}
              />
            ) : (
              <p className="py-6 text-center text-sm text-muted">No resolved alerts in this range.</p>
            )}
          </Card>
        </section>
      )}
    </div>
  );
}
