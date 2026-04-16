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

interface Bucket {
  startMs: number;
  endMs: number;
  total: number;
  failed: number;
  avgResponseMs: number | null;
  /** Representative check for the tooltip — worst status in the bucket. */
  worstCheck: EndpointCheck;
}

const MAX_BUCKETS = 96; // ~15 min buckets for 24h

function bucketChecks(checks: EndpointCheck[]): Bucket[] {
  // Chronological order.
  const sorted = [...checks].reverse();
  if (sorted.length === 0) return [];

  const startMs = parseCheckTime(sorted[0]!.checked_at).getTime();
  const endMs = parseCheckTime(sorted[sorted.length - 1]!.checked_at).getTime();
  const span = Math.max(endMs - startMs, 1);
  const count = Math.min(MAX_BUCKETS, sorted.length);
  const bucketMs = span / count;

  const buckets: Bucket[] = [];
  let bi = 0;
  for (let i = 0; i < count; i++) {
    const bStart = startMs + i * bucketMs;
    const bEnd = startMs + (i + 1) * bucketMs;
    let total = 0;
    let failed = 0;
    let rtSum = 0;
    let rtCount = 0;
    let worst: EndpointCheck | null = null;
    while (bi < sorted.length) {
      const t = parseCheckTime(sorted[bi]!.checked_at).getTime();
      if (t >= bEnd && i < count - 1) break;
      const c = sorted[bi]!;
      total++;
      if (!c.is_up) { failed++; worst = c; }
      if (c.response_time_ms != null) { rtSum += c.response_time_ms; rtCount++; }
      if (!worst) worst = c;
      bi++;
    }
    if (total > 0) {
      buckets.push({
        startMs: bStart, endMs: bEnd, total, failed,
        avgResponseMs: rtCount > 0 ? Math.round(rtSum / rtCount) : null,
        worstCheck: worst!,
      });
    }
  }
  return buckets;
}

/** Compact status strip — checks bucketed into time slots with hover detail. */
function CheckStatusStrip({ checks }: { checks: EndpointCheck[] }) {
  const [hover, setHover] = useState<{ index: number; clientX: number; clientY: number } | null>(null);
  const buckets = useMemo(() => bucketChecks(checks), [checks]);

  if (buckets.length === 0) return null;

  const hovered = hover ? buckets[hover.index] : null;

  const fmtTime = (ms: number) => {
    const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
    return new Date(ms).toLocaleString(undefined, opts);
  };

  return (
    <div className="relative">
      <div
        className="relative flex h-[18px] gap-px"
        onMouseLeave={() => setHover(null)}
      >
        {buckets.map((b, i) => {
          const color = b.failed > 0 ? 'bg-[var(--color-danger)]' : 'bg-[var(--color-success)]';
          const active = hover?.index === i;
          return (
            <div
              key={i}
              className={`flex-1 first:rounded-l-sm last:rounded-r-sm transition-[filter] ${color} ${active ? 'brightness-125' : ''}`}
              onMouseEnter={(e) => setHover({ index: i, clientX: e.clientX, clientY: e.clientY })}
              onMouseMove={(e) => {
                if (hover?.index === i) return;
                setHover({ index: i, clientX: e.clientX, clientY: e.clientY });
              }}
            />
          );
        })}
      </div>
      {/* Time range labels */}
      <div className="mt-1 flex justify-between text-[10px] font-medium text-muted">
        <span>{timeAgo(checks[checks.length - 1]!.checked_at)}</span>
        <span>now</span>
      </div>
      {/* Hover tooltip */}
      {hovered && hover && (
        <div
          className="pointer-events-none fixed z-50 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] shadow-lg"
          style={{ left: hover.clientX + 12, top: hover.clientY + 14 }}
        >
          <div className="flex items-center gap-1.5 font-semibold text-fg">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: hovered.failed > 0 ? 'var(--color-danger)' : 'var(--color-success)' }}
            />
            {hovered.failed > 0 ? `${hovered.failed}/${hovered.total} failed` : `${hovered.total} passed`}
          </div>
          {hovered.avgResponseMs != null && (
            <div className="mt-0.5 text-muted">avg {hovered.avgResponseMs}ms</div>
          )}
          {hovered.failed > 0 && hovered.worstCheck.error && (
            <div className="mt-0.5 text-danger">{hovered.worstCheck.error}</div>
          )}
          <div className="mt-0.5 text-muted">{fmtTime(hovered.startMs)} → {fmtTime(hovered.endMs)}</div>
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
        <Card title={`Check Status (${totalChecks} checks)`}>
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
