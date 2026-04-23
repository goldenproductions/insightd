import { useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import type { EndpointDetail, EndpointCheck } from '@/types/api';
import { useAuth } from '@/context/AuthContext';
import { useKeyboardShortcut } from '@/hooks/useKeyboardShortcut';
import { StatCard, StatsGrid } from '@/components/StatCard';
import { Card } from '@/components/Card';
import { TimeSeriesChart, type ChartSeries } from '@/components/TimeSeriesChart';
import { DataTable, type Column } from '@/components/DataTable';
import { StatusDot } from '@/components/StatusDot';
import { Badge } from '@/components/Badge';
import { LinkButton } from '@/components/FormField';
import { timeAgo } from '@/lib/formatters';
import { BackLink } from '@/components/BackLink';
import { LoadingState } from '@/components/LoadingState';

function parseCheckTime(raw: string): Date {
  return new Date(raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z');
}

function buildResponseChart(checks: EndpointCheck[]): { timestamps: number[]; values: (number | null)[] } | null {
  const chronological = [...checks].reverse();
  const withRT = chronological.filter(c => c.response_time_ms != null);
  if (withRT.length < 2) return null;
  const timestamps = withRT.map(c => Math.floor(parseCheckTime(c.checked_at).getTime() / 1000));
  const values = withRT.map(c => c.response_time_ms);
  return { timestamps, values };
}

const SLOW_RESPONSE_MS = 2000;

function CheckStatusStrip({ checks }: { checks: EndpointCheck[] }) {
  const [hover, setHover] = useState<{ index: number; clientX: number; clientY: number } | null>(null);

  const strip = useMemo(() => [...checks].reverse(), [checks]);

  const dense = strip.length > 200;
  const gapClass = dense ? 'gap-px' : 'gap-[2px]';

  if (strip.length === 0) return null;

  const fmtTime = (raw: string) => {
    const d = parseCheckTime(raw);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  const hovered = hover ? strip[hover.index] : null;

  return (
    <div className="relative">
      <div
        className={`relative flex h-11 items-stretch ${gapClass}`}
        onMouseLeave={() => setHover(null)}
      >
        {strip.map((c, i) => {
          const isUp = c.is_up;
          const slow = isUp && c.response_time_ms != null && c.response_time_ms > SLOW_RESPONSE_MS;
          const color = !isUp ? 'bg-danger' : slow ? 'bg-warning' : 'bg-success';
          const height = !isUp ? '100%' : slow ? '80%' : '55%';
          const active = hover?.index === i;
          return (
            <div
              key={i}
              className={`flex flex-1 items-end transition-[filter] ${active ? 'brightness-125' : ''}`}
              onMouseEnter={(e) => setHover({ index: i, clientX: e.clientX, clientY: e.clientY })}
              onMouseMove={(e) => {
                if (hover?.index === i) return;
                setHover({ index: i, clientX: e.clientX, clientY: e.clientY });
              }}
            >
              <span className={`w-full rounded-sm ${color}`} style={{ height }} />
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-muted">
        <span>24h ago</span>
        <span>now</span>
      </div>
      {hovered && hover && (
        <div
          className="pointer-events-none fixed z-50 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] shadow-lg"
          style={{ left: hover.clientX + 12, top: hover.clientY + 14 }}
        >
          <div className="flex items-center gap-1.5 font-semibold text-fg">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: !hovered.is_up ? 'var(--color-danger)' : (hovered.response_time_ms != null && hovered.response_time_ms > SLOW_RESPONSE_MS) ? 'var(--color-warning)' : 'var(--color-success)' }}
            />
            {hovered.is_up ? (hovered.response_time_ms != null && hovered.response_time_ms > SLOW_RESPONSE_MS ? 'Slow' : 'OK') : 'Failed'}
            {hovered.status_code != null && <span className="ml-1 font-mono text-muted">{hovered.status_code}</span>}
          </div>
          {hovered.response_time_ms != null && (
            <div className="mt-0.5 text-muted">{hovered.response_time_ms}ms</div>
          )}
          {!hovered.is_up && hovered.error && (
            <div className="mt-0.5 text-danger">{hovered.error}</div>
          )}
          <div className="mt-0.5 text-muted">{fmtTime(hovered.checked_at)}</div>
        </div>
      )}
    </div>
  );
}

export function EndpointDetailPage() {
  const { endpointId } = useParams();
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  const { data } = useQuery({ queryKey: queryKeys.endpoint(endpointId), queryFn: () => api<EndpointDetail>(`/endpoints/${endpointId}`), refetchInterval: 30_000 });
  const { data: checks } = useQuery({ queryKey: queryKeys.endpointChecks(endpointId), queryFn: () => api<EndpointCheck[]>(`/endpoints/${endpointId}/checks?hours=24`), refetchInterval: 30_000 });

  const chart = useMemo(() => checks ? buildResponseChart(checks) : null, [checks]);

  const failedChecks = useMemo(() => (checks || []).filter(c => !c.is_up), [checks]);

  useKeyboardShortcut({ keys: 'b', description: 'Back to endpoints', scope: 'Endpoint detail', onTrigger: () => navigate('/endpoints') });
  useKeyboardShortcut({ keys: 'e', description: 'Edit endpoint', scope: 'Endpoint detail', disabled: !isAuthenticated, onTrigger: () => navigate(`/endpoints/${endpointId}/edit`) });

  if (!data) return <LoadingState />;

  const isUp = data.lastCheck ? data.lastCheck.is_up : null;
  const statusText = isUp === null ? 'No data' : isUp ? 'Up' : 'Down';

  const checkColumns: Column<EndpointCheck>[] = [
    { header: 'Time', accessor: r => <span title={r.checked_at}>{timeAgo(r.checked_at)}</span> },
    { header: 'Status', accessor: r => <span className="flex items-center gap-2"><StatusDot status={r.is_up ? 'up' : 'down'} />{r.status_code || '-'}</span> },
    { header: 'Response', accessor: r => r.response_time_ms != null ? `${r.response_time_ms}ms` : '-' },
    { header: 'Error', accessor: r => r.error || '-', className: 'text-xs' },
  ];

  const totalChecks = (checks || []).length;

  return (
    <div className="space-y-6">
      <BackLink to="/endpoints" label="Back to Endpoints" />

      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <StatusDot status={isUp === null ? 'none' : isUp ? 'up' : 'down'} size="lg" />
          <h1 className="text-xl font-bold text-fg">{data.name}</h1>
          <Badge text={statusText} color={isUp === null ? 'gray' : isUp ? 'green' : 'red'} />
        </div>
        {isAuthenticated && (
          <LinkButton to={`/endpoints/${endpointId}/edit`} variant="primary" size="sm" title="Edit endpoint (e)">Edit</LinkButton>
        )}
      </div>

      <p className="text-sm text-muted">
        <span className="font-medium text-secondary">{data.method}</span> {data.url} · expects {data.expected_status} · every {data.interval_seconds}s · timeout {data.timeout_ms}ms
      </p>

      <StatsGrid>
        <StatCard value={data.uptimePercent24h != null ? `${data.uptimePercent24h}%` : '-'} label="Uptime (24h)" color={data.uptimePercent24h != null && data.uptimePercent24h < 99 ? 'var(--color-warning)' : undefined} />
        <StatCard value={data.uptimePercent7d != null ? `${data.uptimePercent7d}%` : '-'} label="Uptime (7d)" color={data.uptimePercent7d != null && data.uptimePercent7d < 99 ? 'var(--color-warning)' : undefined} />
        <StatCard value={data.avgResponseMs != null ? `${data.avgResponseMs}ms` : '-'} label="Avg Response (24h)" color={data.avgResponseMs != null && data.avgResponseMs > 2000 ? 'var(--color-danger)' : data.avgResponseMs != null && data.avgResponseMs > 500 ? 'var(--color-warning)' : undefined} />
        <StatCard value={data.lastCheck?.response_time_ms != null ? `${data.lastCheck.response_time_ms}ms` : '-'} label="Last Response" />
      </StatsGrid>

      {totalChecks > 0 && (
        <Card title={`Check Status (last 24h, ${totalChecks} checks)`}>
          <CheckStatusStrip checks={checks!} />
        </Card>
      )}

      {chart && (
        <Card title="Response Time (last 24h)">
          <TimeSeriesChart
            timestamps={chart.timestamps}
            unit="ms"
            series={[{
              label: 'response',
              color: 'var(--color-info)',
              values: chart.values,
              formatValue: (v) => `${Math.round(v)}ms`,
            }] satisfies ChartSeries[]}
          />
        </Card>
      )}

      {failedChecks.length > 0 && (
        <Card title={`Failed Checks (${failedChecks.length})`}>
          <DataTable columns={checkColumns} data={failedChecks} emptyText="No failed checks" />
        </Card>
      )}
    </div>
  );
}
