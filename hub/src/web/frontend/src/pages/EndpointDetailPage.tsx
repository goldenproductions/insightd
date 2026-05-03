import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
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
import { getTlsStatus, tlsBadgeClass, type TlsStatus } from '@/lib/tls';

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
const MAX_BARS = 240;

type WindowKey = '24h' | '7d' | '30d';
const WINDOW_HOURS: Record<WindowKey, number> = { '24h': 24, '7d': 24 * 7, '30d': 24 * 30 };
const WINDOW_LABEL: Record<WindowKey, string> = { '24h': 'last 24h', '7d': 'last 7d', '30d': 'last 30d' };

function isWindowKey(s: string | null): s is WindowKey {
  return s === '24h' || s === '7d' || s === '30d';
}

type Bucket = {
  startMs: number;
  endMs: number;
  total: number;
  failed: number;
  slow: number;
  up: number;
  worstCheck: EndpointCheck | null;
};

function bucketizeChecks(checks: EndpointCheck[], startMs: number, endMs: number): Bucket[] {
  const bucketMs = (endMs - startMs) / MAX_BARS;
  const buckets: Bucket[] = Array.from({ length: MAX_BARS }, (_, i) => ({
    startMs: startMs + i * bucketMs,
    endMs: startMs + (i + 1) * bucketMs,
    total: 0,
    failed: 0,
    slow: 0,
    up: 0,
    worstCheck: null,
  }));
  for (const c of checks) {
    const t = parseCheckTime(c.checked_at).getTime();
    if (t < startMs || t >= endMs) continue;
    const idx = Math.min(MAX_BARS - 1, Math.floor((t - startMs) / bucketMs));
    const b = buckets[idx]!;
    b.total++;
    const slow = c.is_up && c.response_time_ms != null && c.response_time_ms > SLOW_RESPONSE_MS;
    if (!c.is_up) b.failed++;
    else if (slow) b.slow++;
    else b.up++;
    const rank = (chk: EndpointCheck) => !chk.is_up ? 2 : (chk.response_time_ms != null && chk.response_time_ms > SLOW_RESPONSE_MS) ? 1 : 0;
    if (!b.worstCheck || rank(c) > rank(b.worstCheck)) b.worstCheck = c;
  }
  return buckets;
}

function fmtBucketTime(ms: number, windowMs: number): string {
  const opts: Intl.DateTimeFormatOptions = windowMs > 36 * 3600 * 1000
    ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { hour: '2-digit', minute: '2-digit' };
  return new Date(ms).toLocaleString(undefined, opts);
}

function CheckStatusStrip({
  checks,
  startMs,
  endMs,
  selectedIndex,
  onSelect,
}: {
  checks: EndpointCheck[];
  startMs: number;
  endMs: number;
  selectedIndex: number | null;
  onSelect: (index: number | null) => void;
}) {
  const [hover, setHover] = useState<{ index: number; clientX: number; clientY: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const buckets = useMemo(() => bucketizeChecks(checks, startMs, endMs), [checks, startMs, endMs]);
  const windowMs = endMs - startMs;
  const hovered = hover ? buckets[hover.index] : null;

  return (
    <div className="relative">
      <div
        className="relative grid h-11 items-stretch gap-px select-none"
        style={{ gridTemplateColumns: `repeat(${MAX_BARS}, minmax(0, 1fr))` }}
        onMouseLeave={() => { setHover(null); setIsDragging(false); }}
        onMouseUp={() => setIsDragging(false)}
      >
        {buckets.map((b, i) => {
          const empty = b.total === 0;
          const failed = b.failed > 0;
          const slow = !failed && b.slow > 0;
          const color = empty ? 'bg-border' : failed ? 'bg-danger' : slow ? 'bg-warning' : 'bg-success';
          const height = empty ? '25%' : failed ? '100%' : slow ? '80%' : '55%';
          const active = hover?.index === i;
          const selected = selectedIndex === i;
          return (
            <div
              key={i}
              className={`flex cursor-pointer items-end transition-[filter] ${active ? 'brightness-125' : ''} ${selected ? 'bg-bg-secondary/40' : ''}`}
              onMouseEnter={(e) => {
                setHover({ index: i, clientX: e.clientX, clientY: e.clientY });
                if (isDragging) onSelect(i);
              }}
              onMouseMove={(e) => {
                if (hover?.index !== i) setHover({ index: i, clientX: e.clientX, clientY: e.clientY });
              }}
              onMouseDown={(e) => {
                e.preventDefault();
                setIsDragging(true);
                onSelect(selectedIndex === i ? null : i);
              }}
            >
              <span className={`w-full rounded-sm ${color} ${empty ? 'opacity-40' : ''}`} style={{ height }} />
            </div>
          );
        })}
        {selectedIndex != null && (
          <div
            className="pointer-events-none absolute inset-y-0 w-px bg-fg/70"
            style={{ left: `${((selectedIndex + 0.5) / MAX_BARS) * 100}%` }}
          />
        )}
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-muted">
        <span>{fmtBucketTime(startMs, windowMs)}</span>
        <span>{fmtBucketTime(endMs, windowMs)}</span>
      </div>
      {hovered && hover && (
        <div
          className="pointer-events-none fixed z-50 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] shadow-lg"
          style={{ left: hover.clientX + 12, top: hover.clientY + 14 }}
        >
          {hovered.total === 0 ? (
            <>
              <div className="font-semibold text-muted">No checks</div>
              <div className="mt-0.5 text-muted">{fmtBucketTime(hovered.startMs, windowMs)} – {fmtBucketTime(hovered.endMs, windowMs)}</div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-1.5 font-semibold text-fg">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ background: hovered.failed > 0 ? 'var(--color-danger)' : hovered.slow > 0 ? 'var(--color-warning)' : 'var(--color-success)' }}
                />
                {hovered.failed > 0 ? `${hovered.failed} failed` : hovered.slow > 0 ? `${hovered.slow} slow` : `${hovered.up} ok`}
                <span className="ml-1 text-muted">of {hovered.total}</span>
              </div>
              {hovered.worstCheck?.status_code != null && (
                <div className="mt-0.5 font-mono text-muted">HTTP {hovered.worstCheck.status_code}</div>
              )}
              {hovered.worstCheck?.response_time_ms != null && (
                <div className="mt-0.5 text-muted">{hovered.worstCheck.response_time_ms}ms</div>
              )}
              {hovered.worstCheck && !hovered.worstCheck.is_up && hovered.worstCheck.error && (
                <div className="mt-0.5 text-danger">{hovered.worstCheck.error}</div>
              )}
              <div className="mt-0.5 text-muted">{fmtBucketTime(hovered.startMs, windowMs)} – {fmtBucketTime(hovered.endMs, windowMs)}</div>
              <div className="mt-1 text-[10px] text-muted">click to pin · drag to scrub</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function TimelineControls({
  windowKey,
  isLive,
  endMs,
  onWindowChange,
  onStep,
  onLive,
}: {
  windowKey: WindowKey;
  isLive: boolean;
  endMs: number;
  onWindowChange: (w: WindowKey) => void;
  onStep: (direction: -1 | 1) => void;
  onLive: () => void;
}) {
  const presetClass = (active: boolean) =>
    `rounded px-2 py-1 text-xs font-medium transition-colors ${active ? 'bg-bg-secondary text-fg' : 'text-muted hover:text-fg'}`;
  const iconBtn = 'rounded px-2 py-1 text-xs text-muted hover:bg-bg-secondary hover:text-fg disabled:opacity-30 disabled:hover:bg-transparent';
  return (
    <div className="flex items-center gap-1">
      <span className="mr-1 text-[11px] text-muted">
        {isLive ? <span className="inline-flex items-center gap-1"><span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-success" />Live</span> : new Date(endMs).toLocaleString()}
      </span>
      <button type="button" className={iconBtn} onClick={() => onStep(-1)} title="Step back">←</button>
      <button type="button" className={iconBtn} onClick={() => onStep(1)} disabled={isLive} title="Step forward">→</button>
      <button type="button" className={iconBtn} onClick={onLive} disabled={isLive} title="Jump to now">Now</button>
      <span className="mx-1 text-border">|</span>
      {(['24h', '7d', '30d'] as const).map(w => (
        <button key={w} type="button" className={presetClass(windowKey === w)} onClick={() => onWindowChange(w)}>
          {w}
        </button>
      ))}
    </div>
  );
}

function SelectedMomentPanel({ bucket, checks, windowMs, onClear }: { bucket: Bucket; checks: EndpointCheck[]; windowMs: number; onClear: () => void }) {
  const inBucket = useMemo(() => {
    return checks
      .filter(c => {
        const t = parseCheckTime(c.checked_at).getTime();
        return t >= bucket.startMs && t < bucket.endMs;
      })
      .sort((a, b) => parseCheckTime(b.checked_at).getTime() - parseCheckTime(a.checked_at).getTime());
  }, [checks, bucket]);

  const fmtCheckTime = (raw: string) => parseCheckTime(raw).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const tone = bucket.failed > 0 ? 'danger' : bucket.slow > 0 ? 'warning' : bucket.total > 0 ? 'success' : 'muted';
  const toneBg = { danger: 'bg-danger', warning: 'bg-warning', success: 'bg-success', muted: 'bg-border' }[tone];

  return (
    <div className="mt-3 rounded-lg border border-border bg-bg-secondary/30 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm">
          <span className={`inline-block h-2 w-2 rounded-full ${toneBg}`} />
          <span className="font-semibold text-fg">Selected moment</span>
          <span className="text-muted">{fmtBucketTime(bucket.startMs, windowMs)} – {fmtBucketTime(bucket.endMs, windowMs)}</span>
        </div>
        <button type="button" className="rounded px-2 py-0.5 text-xs text-muted hover:bg-bg-secondary hover:text-fg" onClick={onClear} title="Clear (Esc)">Clear</button>
      </div>
      {bucket.total === 0 ? (
        <p className="mt-2 text-xs text-muted">No checks recorded in this window.</p>
      ) : (
        <>
          <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
            {bucket.failed > 0 && <Badge text={`${bucket.failed} failed`} color="red" />}
            {bucket.slow > 0 && <Badge text={`${bucket.slow} slow`} color="yellow" />}
            {bucket.up > 0 && <Badge text={`${bucket.up} ok`} color="green" />}
            <span className="text-muted">of {bucket.total}</span>
          </div>
          <ul className="mt-3 max-h-56 divide-y divide-border overflow-y-auto rounded border border-border bg-surface text-xs">
            {inBucket.map(c => (
              <li key={c.id} className="flex items-center gap-3 px-2.5 py-1.5">
                <StatusDot status={c.is_up ? 'up' : 'down'} />
                <span className="font-mono text-fg">{c.status_code ?? '—'}</span>
                <span className="text-muted">{c.response_time_ms != null ? `${c.response_time_ms}ms` : '—'}</span>
                <span className="ml-auto text-muted">{fmtCheckTime(c.checked_at)}</span>
                {!c.is_up && c.error && <span className="ml-3 max-w-[40%] truncate text-danger" title={c.error}>{c.error}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function EndpointDetailPage() {
  const { endpointId } = useParams();
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const windowKey: WindowKey = isWindowKey(searchParams.get('window')) ? (searchParams.get('window') as WindowKey) : '24h';
  const atParam = searchParams.get('at');
  const isLive = !atParam;
  const hours = WINDOW_HOURS[windowKey];

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!isLive) return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [isLive]);

  const endMs = useMemo(() => {
    if (atParam) {
      const t = Date.parse(atParam);
      if (!Number.isNaN(t)) return t;
    }
    return nowMs;
  }, [atParam, nowMs]);
  const startMs = endMs - hours * 3600 * 1000;

  const { data } = useQuery({ queryKey: queryKeys.endpoint(endpointId), queryFn: () => api<EndpointDetail>(`/endpoints/${endpointId}`), refetchInterval: 30_000 });
  const { data: checks } = useQuery({
    queryKey: queryKeys.endpointChecks(endpointId, hours, atParam),
    queryFn: () => {
      const params = new URLSearchParams({ hours: String(hours) });
      if (atParam) params.set('at', new Date(endMs).toISOString());
      return api<EndpointCheck[]>(`/endpoints/${endpointId}/checks?${params.toString()}`);
    },
    refetchInterval: isLive ? 30_000 : false,
  });

  const updateParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (value === null) next.delete(key);
    else next.set(key, value);
    setSearchParams(next, { replace: true });
  };

  const handleWindowChange = (w: WindowKey) => updateParam('window', w === '24h' ? null : w);
  const handleStep = (direction: -1 | 1) => {
    const stepMs = (hours * 3600 * 1000) / 2;
    const proposed = endMs + direction * stepMs;
    const clamped = Math.min(proposed, Date.now());
    if (clamped >= Date.now() - 1000) updateParam('at', null);
    else updateParam('at', new Date(clamped).toISOString());
  };
  const handleLive = () => updateParam('at', null);

  const buckets = useMemo(() => bucketizeChecks(checks || [], startMs, endMs), [checks, startMs, endMs]);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  useEffect(() => { setSelectedIndex(null); }, [windowKey, atParam]);
  useEffect(() => {
    if (selectedIndex == null) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setSelectedIndex(null); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedIndex]);

  const visibleChecks = useMemo(() => {
    return (checks || []).filter(c => {
      const t = parseCheckTime(c.checked_at).getTime();
      return t >= startMs && t <= endMs;
    });
  }, [checks, startMs, endMs]);

  const chart = useMemo(() => buildResponseChart(visibleChecks), [visibleChecks]);
  const failedChecks = useMemo(() => visibleChecks.filter(c => !c.is_up), [visibleChecks]);

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

  const totalChecks = visibleChecks.length;
  const windowLabel = WINDOW_LABEL[windowKey];
  const selectedBucket = selectedIndex != null ? buckets[selectedIndex] : null;

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

      {data.url.startsWith('https://') && <TlsCard endpoint={data} />}

      <Card
        title={`Check Status (${windowLabel}, ${totalChecks} check${totalChecks === 1 ? '' : 's'})`}
        actions={<TimelineControls
          windowKey={windowKey}
          isLive={isLive}
          endMs={endMs}
          onWindowChange={handleWindowChange}
          onStep={handleStep}
          onLive={handleLive}
        />}
      >
        {totalChecks === 0 && !checks ? (
          <div className="h-11 animate-pulse rounded bg-bg-secondary/50" />
        ) : totalChecks === 0 ? (
          <p className="py-3 text-sm text-muted">No checks in this window.</p>
        ) : (
          <CheckStatusStrip
            checks={visibleChecks}
            startMs={startMs}
            endMs={endMs}
            selectedIndex={selectedIndex}
            onSelect={setSelectedIndex}
          />
        )}
        {selectedBucket && (
          <SelectedMomentPanel bucket={selectedBucket} checks={visibleChecks} windowMs={endMs - startMs} onClear={() => setSelectedIndex(null)} />
        )}
      </Card>

      {chart && (
        <Card title={`Response Time (${windowLabel})`}>
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

function describeTlsState(s: TlsStatus): { headline: string; sub: string } {
  switch (s.state) {
    case 'expired': return { headline: 'Certificate expired', sub: 'Browsers will block this endpoint until the certificate is renewed.' };
    case 'expiring': return { headline: `Expires in ${s.daysLeft} day${s.daysLeft === 1 ? '' : 's'}`, sub: 'Renew before expiry to avoid downtime.' };
    case 'invalid': return { headline: `Certificate invalid (${s.label})`, sub: 'Connections may fail or trigger browser warnings.' };
    case 'valid': return { headline: `Valid for ${s.daysLeft} day${s.daysLeft === 1 ? '' : 's'}`, sub: 'Healthy.' };
    default: return { headline: 'No certificate data', sub: 'Waiting for the next probe.' };
  }
}

function TlsCard({ endpoint }: { endpoint: EndpointDetail }) {
  const status = getTlsStatus(endpoint);
  if (!status) {
    return (
      <Card title="TLS certificate">
        <p className="text-sm text-muted">Waiting for first certificate probe.</p>
      </Card>
    );
  }
  const desc = describeTlsState(status);
  const sans = endpoint.tls_subject_alt_names ? endpoint.tls_subject_alt_names.split(',').filter(Boolean) : [];
  return (
    <Card title="TLS certificate">
      <div className="flex flex-wrap items-baseline gap-3">
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${tlsBadgeClass(status.tone)}`}>
          {status.label}
        </span>
        <span className="text-sm font-semibold text-fg">{desc.headline}</span>
      </div>
      <p className="mt-1 text-xs text-muted">{desc.sub}</p>

      <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted">Expires</dt>
          <dd className="text-fg">
            {endpoint.tls_expires_at
              ? new Date(endpoint.tls_expires_at).toLocaleString()
              : '—'}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Issuer</dt>
          <dd className="truncate text-fg" title={endpoint.tls_issuer || ''}>{endpoint.tls_issuer || '—'}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs text-muted">Subject alternative names</dt>
          <dd className="flex flex-wrap gap-1.5">
            {sans.length > 0
              ? sans.map(s => <span key={s} className="rounded bg-bg-secondary px-1.5 py-0.5 font-mono text-xs text-secondary">{s}</span>)
              : <span className="text-fg">—</span>}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs text-muted">Last probed</dt>
          <dd className="text-fg">
            {endpoint.tls_last_checked_at
              ? <span title={endpoint.tls_last_checked_at}>{timeAgo(endpoint.tls_last_checked_at)}</span>
              : '—'}
            {endpoint.tls_error && status.state !== 'invalid' && status.state !== 'expired' && (
              <span className="ml-2 text-xs text-warning">last probe error: {endpoint.tls_error}</span>
            )}
          </dd>
        </div>
      </dl>
    </Card>
  );
}
