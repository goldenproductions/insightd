import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { HostDetail, Trends, ContainerSnapshot, DiskSnapshot, DiskForecastItem, UpdateCheck } from '@/types/api';
import { Card } from '@/components/Card';
import { EmptyState } from '@/components/EmptyState';
import { TrendArrow } from '@/components/TrendArrow';
import { StatusDot } from '@/components/StatusDot';
import { fmtPercent, fmtBytes, timeAgo } from '@/lib/formatters';
import { getContainerNamespace, getContainerDisplayName, isInternalContainer, deriveContainerDisplayStatus } from '@/lib/containers';

interface Props {
  data: HostDetail;
  trends: Trends | undefined;
}

// ── thresholds ───────────────────────────────────────────────────────────
// Match the "saturation is the problem" philosophy in CLAUDE.md.
const CPU_THRESHOLDS = { warn: 70, crit: 85 };
const MEM_THRESHOLDS = { warn: 80, crit: 90 };
const DISK_THRESHOLDS = { warn: 85, crit: 90 };
const LIMIT_THRESHOLDS = { warn: 75, crit: 90 };

function pctTone(pct: number | null | undefined, t: { warn: number; crit: number }): 'success' | 'warning' | 'danger' | 'muted' {
  if (pct == null) return 'muted';
  if (pct >= t.crit) return 'danger';
  if (pct >= t.warn) return 'warning';
  return 'success';
}

function toneToColor(tone: 'success' | 'warning' | 'danger' | 'muted'): string {
  return tone === 'danger' ? 'var(--color-danger)'
    : tone === 'warning' ? 'var(--color-warning)'
    : tone === 'success' ? 'var(--color-success)'
    : 'var(--color-muted)';
}

function loadStatus(load: number | null | undefined): { label: string; tone: 'success' | 'warning' | 'danger' | 'muted'; pct: number } {
  if (load == null) return { label: '—', tone: 'muted', pct: 0 };
  // Cap visualization at 4.0 = 100% (matches the >4 threshold for "high").
  const pct = Math.min(100, (load / 4) * 100);
  if (load >= 4) return { label: 'High', tone: 'danger', pct };
  if (load >= 2) return { label: 'Elevated', tone: 'warning', pct };
  if (load >= 1) return { label: 'Normal', tone: 'success', pct };
  return { label: 'Idle', tone: 'success', pct };
}

// ── shared bar row ───────────────────────────────────────────────────────
function CapacityRow({ label, value, percent, tone, sub }: {
  label: string;
  value: string;
  percent: number;
  tone: 'success' | 'warning' | 'danger' | 'muted';
  sub?: string;
}) {
  const color = toneToColor(tone);
  return (
    <div className="flex items-center gap-4">
      <div className="w-24 shrink-0 text-xs font-medium uppercase tracking-wider text-secondary">{label}</div>
      <div className="flex-1">
        <div className="h-2 w-full rounded-full bg-border">
          <div className="h-2 rounded-full transition-all" style={{ width: `${Math.min(percent, 100)}%`, backgroundColor: color }} />
        </div>
        {sub && <div className="mt-1 text-[10px] text-muted">{sub}</div>}
      </div>
      <div className="w-32 shrink-0 text-right">
        <span className="font-mono text-sm font-semibold tabular-nums" style={{ color }}>{value}</span>
      </div>
    </div>
  );
}

// ── 1. capacity headline ─────────────────────────────────────────────────
function CapacitySection({ data }: { data: HostDetail }) {
  const hm = data.hostMetrics;
  if (!hm) return null;

  const memPct = hm.memory_total_mb && hm.memory_total_mb > 0 && hm.memory_used_mb != null
    ? (hm.memory_used_mb / hm.memory_total_mb) * 100
    : null;
  const cpuTone = pctTone(hm.cpu_percent, CPU_THRESHOLDS);
  const memTone = pctTone(memPct, MEM_THRESHOLDS);
  const load = loadStatus(hm.load_5);

  return (
    <Card title="Capacity">
      <div className="space-y-3">
        <CapacityRow
          label="CPU"
          value={fmtPercent(hm.cpu_percent)}
          percent={hm.cpu_percent ?? 0}
          tone={cpuTone}
        />
        <CapacityRow
          label="Memory"
          value={memPct != null ? `${memPct.toFixed(1)}%` : '—'}
          percent={memPct ?? 0}
          tone={memTone}
          sub={hm.memory_total_mb && hm.memory_used_mb != null
            ? `${Math.round(hm.memory_used_mb)} / ${Math.round(hm.memory_total_mb)} MB`
            : undefined}
        />
        <CapacityRow
          label="Load (5m)"
          value={hm.load_5 != null ? `${hm.load_5.toFixed(2)} · ${load.label}` : '—'}
          percent={load.pct}
          tone={load.tone}
        />
      </div>
    </Card>
  );
}

// ── 2. storage ───────────────────────────────────────────────────────────
function forecastChip(f: DiskForecastItem | undefined): { text: string; tone: 'danger' | 'warning' | 'muted' } | null {
  if (!f || f.daysUntilFull == null) return null;
  if (f.daysUntilFull < 14) return { text: `fills in ~${f.daysUntilFull}d`, tone: 'danger' };
  if (f.daysUntilFull < 90) return { text: `fills in ~${f.daysUntilFull}d`, tone: 'warning' };
  return null;
}

function StorageSection({ disk, forecasts }: { disk: DiskSnapshot[]; forecasts: DiskForecastItem[] }) {
  if (disk.length === 0) return null;
  const fcByMount = new Map(forecasts.map(f => [f.mountPoint, f]));
  return (
    <Card title="Storage">
      <div className="space-y-3">
        {disk.map(d => {
          const tone = pctTone(d.used_percent, DISK_THRESHOLDS);
          const color = toneToColor(tone);
          const chip = forecastChip(fcByMount.get(d.mount_point));
          const chipCls = chip?.tone === 'danger' ? 'bg-danger/10 text-danger border-danger/30'
            : chip?.tone === 'warning' ? 'bg-warning/10 text-warning border-warning/30'
            : 'bg-bg-secondary text-muted border-border';
          return (
            <div key={d.mount_point} className="flex items-center gap-4">
              <div className="w-32 shrink-0 truncate font-mono text-xs text-secondary" title={d.mount_point}>{d.mount_point}</div>
              <div className="flex-1">
                <div className="h-2 w-full rounded-full bg-border">
                  <div className="h-2 rounded-full transition-all" style={{ width: `${Math.min(d.used_percent, 100)}%`, backgroundColor: color }} />
                </div>
                <div className="mt-1 text-[10px] text-muted">{d.used_gb} / {d.total_gb} GB</div>
              </div>
              <div className="flex w-44 shrink-0 items-center justify-end gap-2">
                {chip && <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${chipCls}`}>{chip.text}</span>}
                <span className="font-mono text-sm font-semibold tabular-nums" style={{ color }}>{d.used_percent}%</span>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ── 3. top consumers ─────────────────────────────────────────────────────
function ConsumerRow({ hostId, container, max, formatValue, tone = 'success' }: {
  hostId: string;
  container: ContainerSnapshot;
  max: number;
  formatValue: (c: ContainerSnapshot) => string;
  tone?: 'success' | 'warning' | 'danger' | 'muted';
}) {
  const ns = getContainerNamespace(container.container_name);
  const display = getContainerDisplayName(container.container_name);
  const value = formatValue(container);
  const numVal = parseFloat(value);
  const pct = max > 0 && Number.isFinite(numVal) ? Math.max(2, Math.min(100, (numVal / max) * 100)) : 0;
  const color = toneToColor(tone);
  const derived = deriveContainerDisplayStatus(container.status, container.exit_code);
  return (
    <Link to={`/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(container.container_name)}`}
      className="flex items-center gap-2 rounded px-1 py-1 -mx-1 hover-surface">
      <StatusDot status={container.is_stale ? 'stale' : derived.dot} />
      <div className="min-w-0 flex-1 truncate text-xs">
        {ns ? <><span className="text-muted">{ns}/</span><span className="text-fg">{display}</span></> : <span className="text-fg">{container.container_name}</span>}
      </div>
      <div className="h-1 w-12 shrink-0 rounded-full bg-border">
        <div className="h-1 rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
      <span className="w-20 shrink-0 text-right font-mono text-xs tabular-nums text-fg">{value}</span>
    </Link>
  );
}

function TopConsumersSection({ hostId, containers }: { hostId: string; containers: ContainerSnapshot[] }) {
  const running = useMemo(
    () => containers.filter(c => c.status === 'running' && !isInternalContainer(c.labels)),
    [containers],
  );

  const topCpu = useMemo(
    () => [...running].filter(c => c.cpu_percent != null).sort((a, b) => (b.cpu_percent! - a.cpu_percent!)).slice(0, 5),
    [running],
  );
  const topMem = useMemo(
    () => [...running].filter(c => c.memory_mb != null).sort((a, b) => (b.memory_mb! - a.memory_mb!)).slice(0, 5),
    [running],
  );
  const topDisk = useMemo(
    () => [...running].filter(c => c.size_rootfs_bytes != null).sort((a, b) => (b.size_rootfs_bytes! - a.size_rootfs_bytes!)).slice(0, 5),
    [running],
  );

  if (topCpu.length === 0 && topMem.length === 0 && topDisk.length === 0) return null;

  const maxCpu = topCpu[0]?.cpu_percent ?? 0;
  const maxMem = topMem[0]?.memory_mb ?? 0;
  const maxDisk = topDisk[0]?.size_rootfs_bytes ?? 0;
  const showDisk = topDisk.length > 0;

  return (
    <Card title="Top consumers (now)">
      <div className={`grid gap-6 ${showDisk ? 'lg:grid-cols-3 md:grid-cols-2' : 'md:grid-cols-2'}`}>
        <div>
          <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-muted">By CPU</div>
          <div className="space-y-1">
            {topCpu.map(c => (
              <ConsumerRow
                key={c.container_name} hostId={hostId} container={c}
                max={maxCpu}
                formatValue={c => fmtPercent(c.cpu_percent)}
                tone={pctTone(c.cpu_percent, CPU_THRESHOLDS)}
              />
            ))}
            {topCpu.length === 0 && <div className="text-xs text-muted">No data.</div>}
          </div>
        </div>
        <div>
          <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-muted">By Memory</div>
          <div className="space-y-1">
            {topMem.map(c => (
              <ConsumerRow
                key={c.container_name} hostId={hostId} container={c}
                max={maxMem}
                formatValue={c => c.memory_mb != null ? `${Math.round(c.memory_mb)} MB` : '—'}
                tone={pctTone(c.memory_limit_percent, MEM_THRESHOLDS)}
              />
            ))}
            {topMem.length === 0 && <div className="text-xs text-muted">No data.</div>}
          </div>
        </div>
        {showDisk && (
          <div>
            <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-muted">By Disk size</div>
            <div className="space-y-1">
              {topDisk.map(c => (
                <ConsumerRow
                  key={c.container_name} hostId={hostId} container={c}
                  max={maxDisk}
                  formatValue={c => fmtBytes(c.size_rootfs_bytes)}
                  tone="success"
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

// ── 4. near limits ───────────────────────────────────────────────────────
function NearLimitsSection({ hostId, containers }: { hostId: string; containers: ContainerSnapshot[] }) {
  const items = useMemo(() => {
    return containers
      .filter(c => c.status === 'running' && !isInternalContainer(c.labels))
      .map(c => ({
        c,
        cpuPct: c.cpu_limit_percent ?? null,
        memPct: c.memory_limit_percent ?? null,
      }))
      .filter(x => (x.cpuPct != null && x.cpuPct >= LIMIT_THRESHOLDS.warn) || (x.memPct != null && x.memPct >= LIMIT_THRESHOLDS.warn))
      .sort((a, b) => Math.max(b.cpuPct ?? 0, b.memPct ?? 0) - Math.max(a.cpuPct ?? 0, a.memPct ?? 0));
  }, [containers]);

  if (items.length === 0) return null;

  return (
    <Card title="Near limits">
      <p className="mb-3 text-xs text-muted">{items.length} container{items.length === 1 ? '' : 's'} at ≥ {LIMIT_THRESHOLDS.warn}% of its CPU or memory limit.</p>
      <div className="space-y-1.5">
        {items.map(({ c, cpuPct, memPct }) => {
          const ns = getContainerNamespace(c.container_name);
          const display = getContainerDisplayName(c.container_name);
          const cpuTone = pctTone(cpuPct, LIMIT_THRESHOLDS);
          const memTone = pctTone(memPct, LIMIT_THRESHOLDS);
          const pillCls = (tone: 'success' | 'warning' | 'danger' | 'muted') =>
            tone === 'danger' ? 'bg-danger/10 text-danger border-danger/30'
              : tone === 'warning' ? 'bg-warning/10 text-warning border-warning/30'
              : 'bg-bg-secondary text-muted border-border';
          return (
            <Link key={c.container_name} to={`/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(c.container_name)}`}
              className="flex items-center gap-3 rounded px-2 py-1.5 -mx-2 hover-surface">
              <StatusDot status="running" />
              <div className="min-w-0 flex-1 truncate text-xs">
                {ns ? <><span className="text-muted">{ns}/</span><span className="text-fg font-medium">{display}</span></> : <span className="text-fg font-medium">{c.container_name}</span>}
              </div>
              {cpuPct != null && cpuPct >= LIMIT_THRESHOLDS.warn && (
                <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] tabular-nums ${pillCls(cpuTone)}`}>CPU {cpuPct}%</span>
              )}
              {memPct != null && memPct >= LIMIT_THRESHOLDS.warn && (
                <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] tabular-nums ${pillCls(memTone)}`}>MEM {memPct}%</span>
              )}
            </Link>
          );
        })}
      </div>
    </Card>
  );
}

// ── 5. trends ────────────────────────────────────────────────────────────
function TrendsSection({ trends }: { trends: Trends | undefined }) {
  const [showAll, setShowAll] = useState(false);
  if (!trends || trends.containers.length === 0) return null;
  const flagged = trends.containers.filter(t => t.flagged);
  const visible = showAll ? trends.containers : flagged;
  if (visible.length === 0 && flagged.length === 0) {
    return (
      <Card title="Trends (vs last week)" actions={
        <button type="button" onClick={() => setShowAll(true)} className="text-xs text-primary hover:underline">
          Show all ({trends.containers.length})
        </button>
      }>
        <p className="text-xs text-muted">No significant changes from last week.</p>
      </Card>
    );
  }

  return (
    <Card title="Trends (vs last week)" actions={
      <button type="button" onClick={() => setShowAll(v => !v)}
        className="rounded border border-border bg-surface px-2 py-1 text-xs font-medium text-secondary hover:bg-surface-hover hover:text-fg">
        {showAll ? `Flagged only (${flagged.length})` : `Show all (${trends.containers.length})`}
      </button>
    }>
      <div className="space-y-1.5">
        {visible.map(t => {
          const ns = getContainerNamespace(t.name);
          const display = getContainerDisplayName(t.name);
          return (
            <div key={t.name} className="flex items-center gap-3 rounded px-2 py-1.5 text-xs">
              <div className="min-w-0 flex-1 truncate">
                {ns ? <><span className="text-muted">{ns}/</span><span className="text-fg">{display}</span></> : <span className="text-fg">{t.name}</span>}
              </div>
              <div className="flex w-32 shrink-0 items-center justify-end gap-1.5">
                <span className="text-muted">CPU</span>
                <span className="font-mono tabular-nums text-fg">{fmtPercent(t.cpuNow)}</span>
                <TrendArrow change={t.cpuChange} />
              </div>
              <div className="flex w-32 shrink-0 items-center justify-end gap-1.5">
                <span className="text-muted">Mem</span>
                <span className="font-mono tabular-nums text-fg">{t.memNow != null ? `${t.memNow} MB` : '—'}</span>
                <TrendArrow change={t.memChange} />
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ── 6. updates ───────────────────────────────────────────────────────────
function UpdatesSection({ updates, hostId }: { updates: UpdateCheck[]; hostId: string }) {
  const grouped = useMemo(() => {
    const m = new Map<string, { image: string; containers: UpdateCheck[]; checked_at: string }>();
    for (const u of updates) {
      const e = m.get(u.image);
      if (e) {
        e.containers.push(u);
        if (u.checked_at > e.checked_at) e.checked_at = u.checked_at;
      } else {
        m.set(u.image, { image: u.image, containers: [u], checked_at: u.checked_at });
      }
    }
    return [...m.values()].sort((a, b) => a.image.localeCompare(b.image));
  }, [updates]);

  if (grouped.length === 0) return null;

  return (
    <Card title="Updates available">
      <p className="mb-3 text-xs text-muted">{updates.length} container{updates.length === 1 ? '' : 's'} across {grouped.length} image{grouped.length === 1 ? '' : 's'}.</p>
      <div className="space-y-1.5">
        {grouped.map(g => (
          <div key={g.image} className="flex items-start gap-3 rounded px-2 py-1.5 text-xs">
            <div className="min-w-0 flex-1">
              <div className="font-mono text-fg break-all">{g.image}</div>
              <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-muted">
                {g.containers.slice(0, 6).map(c => (
                  <Link key={c.container_name} to={`/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(c.container_name)}`}
                    className="hover:text-fg hover:underline">
                    {getContainerDisplayName(c.container_name)}
                  </Link>
                ))}
                {g.containers.length > 6 && <span>+{g.containers.length - 6} more</span>}
              </div>
            </div>
            <span className="shrink-0 text-[10px] text-muted">checked {timeAgo(g.checked_at)}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ── tab ──────────────────────────────────────────────────────────────────
export function HostResourcesTab({ data, trends }: Props) {
  const hasAny = !!data.hostMetrics
    || data.disk.length > 0
    || data.containers.length > 0
    || data.updates.length > 0
    || (trends && trends.containers.length > 0);

  if (!hasAny) return <EmptyState message="No resource data available" />;

  return (
    <div className="space-y-6">
      <CapacitySection data={data} />
      <StorageSection disk={data.disk} forecasts={data.diskForecast} />
      <TopConsumersSection hostId={data.host_id} containers={data.containers} />
      <NearLimitsSection hostId={data.host_id} containers={data.containers} />
      <TrendsSection trends={trends} />
      <UpdatesSection updates={data.updates} hostId={data.host_id} />
    </div>
  );
}
