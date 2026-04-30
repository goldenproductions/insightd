import { useState } from 'react';
import type { BaselineBucket, BaselineMetricView, BaselineMetricUnit, BaselineTimeBucket, ContainerBaselinesResponse, HostBaselinesResponse } from '@/types/api';
import { Card } from '@/components/Card';
import { GlossaryHelp } from '@/components/GlossaryHelp';
import { fmtBytesPerSec, fmtCelsius, fmtPercent, timeAgo } from '@/lib/formatters';

interface Props {
  data: HostBaselinesResponse | ContainerBaselinesResponse | undefined;
}

const METRIC_LABELS: Record<string, string> = {
  cpu_percent: 'CPU',
  memory_used_mb: 'Memory',
  memory_mb: 'Memory',
  swap_used_mb: 'Swap',
  load_1: 'Load (1m)',
  load_5: 'Load (5m)',
  load_15: 'Load (15m)',
  gpu_utilization_percent: 'GPU',
  cpu_temperature_celsius: 'CPU temp',
  gpu_temperature_celsius: 'GPU temp',
  disk_read_bytes_per_sec: 'Disk read',
  disk_write_bytes_per_sec: 'Disk write',
  net_rx_bytes_per_sec: 'Net rx',
  net_tx_bytes_per_sec: 'Net tx',
};

const BUCKET_LABELS: Record<BaselineTimeBucket, string> = {
  all: 'All time',
  weekday: 'Weekday',
  weekend: 'Weekend',
  night: 'Night (00-04)',
  early_morning: 'Early morning (04-08)',
  morning: 'Morning (08-12)',
  afternoon: 'Afternoon (12-16)',
  evening: 'Evening (16-20)',
  late_evening: 'Late evening (20-24)',
};

function fmtMetric(unit: BaselineMetricUnit, v: number | null): string {
  if (v == null) return '—';
  if (unit === 'percent') return fmtPercent(v);
  if (unit === 'celsius') return fmtCelsius(v);
  if (unit === 'bytes_per_sec') return fmtBytesPerSec(v);
  if (unit === 'mb') return `${Math.round(v)} MB`;
  if (unit === 'load') return v.toFixed(2);
  return v.toString();
}

function activeBucket(buckets: BaselineBucket[]): BaselineBucket | null {
  // Prefer time-of-day match, fall back to weekday/weekend, then 'all'.
  const periods: BaselineTimeBucket[] = ['night', 'early_morning', 'morning', 'afternoon', 'evening', 'late_evening'];
  const period = buckets.find(b => b.is_current && periods.includes(b.time_bucket));
  if (period) return period;
  const dow = buckets.find(b => b.is_current && (b.time_bucket === 'weekday' || b.time_bucket === 'weekend'));
  if (dow) return dow;
  return buckets.find(b => b.time_bucket === 'all') ?? buckets[0] ?? null;
}

/**
 * Mini-bar that places min → p50 → p95 → max along a horizontal range and
 * draws a tick at the current live value. Tone of the tick reflects severity.
 */
function MiniBar({ bucket, live, tone }: { bucket: BaselineBucket; live: number | null; tone: 'normal' | 'warn' | 'high' }) {
  const min = bucket.min_val;
  const max = bucket.max_val;
  const p50 = bucket.p50;
  const p95 = bucket.p95;
  if (min == null || max == null || p50 == null || p95 == null || max <= min) {
    return <div className="h-1.5 rounded bg-bg-secondary" />;
  }
  const range = max - min;
  const x = (v: number) => Math.max(0, Math.min(100, ((v - min) / range) * 100));
  const tickClass = tone === 'high' ? 'bg-danger' : tone === 'warn' ? 'bg-warning' : 'bg-success';
  return (
    <div className="relative h-1.5 rounded bg-bg-secondary">
      <div className="absolute h-full rounded bg-border" style={{ left: `${x(p50)}%`, width: `${Math.max(0, x(p95) - x(p50))}%` }} />
      <div className="absolute h-full w-px bg-fg/40" style={{ left: `${x(p50)}%` }} title={`p50 ${p50}`} />
      {live != null && (
        <div
          className={`absolute -top-0.5 h-2.5 w-0.5 rounded ${tickClass}`}
          style={{ left: `calc(${x(live)}% - 1px)` }}
          title={`live ${live}`}
        />
      )}
    </div>
  );
}

function MetricRow({ m }: { m: BaselineMetricView }) {
  const [open, setOpen] = useState(false);
  const cur = activeBucket(m.buckets);

  // Tone for the live tick: high if above p95, warn if above p75 capped by capacity floor.
  let tone: 'normal' | 'warn' | 'high' = 'normal';
  if (cur && m.live_value != null) {
    if (cur.p95 != null && m.live_value > cur.p95) tone = 'high';
    else if (cur.p75 != null && m.live_value > cur.p75) tone = 'warn';
  }

  // Capacity gate: if the live value is above baseline but below the capacity
  // floor, the detector won't fire — surface that to short-circuit "but the
  // baseline says spike?" confusion.
  const wouldAlert =
    m.capacity_floor != null && m.live_value != null && m.live_value >= m.capacity_floor;
  const showWontAlert =
    tone !== 'normal' && m.capacity_floor != null && m.live_value != null && !wouldAlert;

  const z = cur?.live_robust_z ?? null;
  const zToneClass =
    z == null ? 'bg-bg-secondary text-muted'
    : z >= 5 ? 'bg-danger/10 text-danger'
    : z >= 2 ? 'bg-warning/10 text-warning'
    : 'bg-success/10 text-success';

  return (
    <li className="rounded border border-border/50 bg-bg-secondary/40 px-3 py-2.5">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="flex w-full items-center gap-3 text-left"
        aria-expanded={open}
      >
        <span className="w-24 text-xs font-medium text-fg">{METRIC_LABELS[m.metric] ?? m.metric}</span>
        <span className="w-20 text-right font-mono text-xs tabular-nums text-fg">{fmtMetric(m.unit, m.live_value)}</span>
        <div className="flex-1">{cur && <MiniBar bucket={cur} live={m.live_value} tone={tone} />}</div>
        <div className="flex shrink-0 items-center gap-1.5">
          {z != null && (
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium tabular-nums ${zToneClass}`} title="Robust z-score vs current bucket">
              z={z.toFixed(1)}
            </span>
          )}
          {showWontAlert && (
            <span className="rounded bg-bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted" title="Above baseline but below the alert capacity floor">
              won't alert
            </span>
          )}
          <span className="text-muted">{open ? '▾' : '▸'}</span>
        </div>
      </button>

      {open && (
        <div className="mt-2.5 overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left text-muted">
                <th className="py-1 pr-2 font-medium">Bucket</th>
                <th className="py-1 pr-2 text-right font-medium tabular-nums">p50</th>
                <th className="py-1 pr-2 text-right font-medium tabular-nums">p95</th>
                <th className="py-1 pr-2 text-right font-medium tabular-nums">p99</th>
                <th className="py-1 pr-2 text-right font-medium tabular-nums">samples</th>
              </tr>
            </thead>
            <tbody>
              {m.buckets.map(b => (
                <tr key={b.time_bucket} className={b.is_current ? 'font-medium text-fg' : 'text-muted'}>
                  <td className="py-1 pr-2">
                    {BUCKET_LABELS[b.time_bucket]}
                    {b.is_current && <span className="ml-1.5 rounded bg-info/10 px-1 py-0 text-[9px] uppercase text-info">current</span>}
                  </td>
                  <td className="py-1 pr-2 text-right font-mono tabular-nums">{fmtMetric(m.unit, b.p50)}</td>
                  <td className="py-1 pr-2 text-right font-mono tabular-nums">{fmtMetric(m.unit, b.p95)}</td>
                  <td className="py-1 pr-2 text-right font-mono tabular-nums">{fmtMetric(m.unit, b.p99)}</td>
                  <td className="py-1 pr-2 text-right font-mono tabular-nums">{b.sample_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {m.capacity_floor != null && (
            <div className="mt-2 text-[10px] text-muted">
              Alert floor: {fmtMetric(m.unit, m.capacity_floor)}
              {m.capacity_floor_kind === 'capacity' && ' (80% of total)'}
              {m.capacity_floor_kind === 'p95_plus' && ' (p95 + 500 MB)'}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Per-metric baselines audit. Renders nothing when there are no rows — many
 * entities won't have baselines yet (new agents, sub-threshold sample counts).
 * Default collapsed; users open the Explore drawer first, then expand.
 */
export function BaselinesViewer({ data }: Props) {
  const [expanded, setExpanded] = useState(false);
  if (!data || data.metrics.length === 0) return null;

  const onlyAll = data.metrics.every(m => m.buckets.length === 1 && m.buckets[0]?.time_bucket === 'all');
  const summary = `${data.metrics.length} metric${data.metrics.length === 1 ? '' : 's'} with baselines`
    + (data.computed_at ? ` · last computed ${timeAgo(data.computed_at)}` : '')
    + (onlyAll ? ' · time-of-day not yet learned' : '');

  return (
    <Card
      title={<>Baselines<GlossaryHelp topic="baselines" /></>}
      actions={
        <button
          onClick={() => setExpanded(v => !v)}
          className="text-xs text-muted hover:text-fg transition-colors"
        >
          {expanded ? 'Hide' : 'Show'}
        </button>
      }
    >
      <p className="text-xs text-muted">{summary}</p>
      {expanded && (
        <ul className="mt-3 space-y-1.5">
          {data.metrics.map(m => <MetricRow key={m.metric} m={m} />)}
        </ul>
      )}
    </Card>
  );
}
