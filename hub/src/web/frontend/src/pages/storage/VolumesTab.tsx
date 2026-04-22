import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiAuth } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { useAuth } from '@/context/AuthContext';
import { EmptyState } from '@/components/EmptyState';
import { CardSkeleton } from '@/components/Skeleton';
import { fmtBytes } from '@/lib/formatters';
import type { VolumesOverview, VolumesOverviewHost, PvsOverview } from '@/types/api';
import { FacetGroup } from './FacetGroup';
import { K8sPvsTab } from './K8sPvsTab';

export type VolumeStateFilter = 'all' | 'orphaned' | 'in-use';
export type VolumeMode = 'docker' | 'k8s';
export type PvPhaseFilter = 'all' | 'Bound' | 'Available' | 'Released' | 'Pending' | 'Failed';
export type PvStateFilter = 'all' | 'orphaned';

export interface VolumeFilters {
  mode: VolumeMode;
  hosts: string[];
  drivers: string[];
  state: VolumeStateFilter;
  // K8s-specific
  clusters: string[];
  phases: PvPhaseFilter[];
  storageClasses: string[];
  pvState: PvStateFilter;
}

interface Props {
  isActive: boolean;
  filters: VolumeFilters;
  onFiltersChange: (patch: Partial<VolumeFilters>) => void;
}

export function VolumesTab({ isActive, filters, onFiltersChange }: Props) {
  const { token } = useAuth();

  // Fetch both so the mode toggle can show counts. Docker is always paid
  // for by existing behaviour; /api/pvs is cheap when there are no PVs.
  const { data: volumes, isLoading: volumesLoading } = useQuery({
    queryKey: queryKeys.volumes(),
    queryFn: () => apiAuth<VolumesOverview>('GET', '/volumes', undefined, token),
    enabled: isActive && !!token,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const { data: pvs, isLoading: pvsLoading } = useQuery({
    queryKey: queryKeys.pvs(),
    queryFn: () => apiAuth<PvsOverview>('GET', '/pvs', undefined, token),
    enabled: isActive && !!token,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  if (volumesLoading || pvsLoading || !volumes || !pvs) return <CardSkeleton lines={8} />;

  const dockerAvailable = volumes.totals.volumeCount > 0;
  const k8sAvailable = pvs.totals.pvCount > 0;

  // If the persisted mode has no data but the other side does, auto-swap.
  // (Covers: bookmarked ?vMode=k8s URL where k8s later drained out, new
  // fleets that only have Docker, etc.)
  const effectiveMode: VolumeMode =
    filters.mode === 'k8s' && !k8sAvailable && dockerAvailable ? 'docker'
    : filters.mode === 'docker' && !dockerAvailable && k8sAvailable ? 'k8s'
    : filters.mode;

  const showToggle = dockerAvailable && k8sAvailable;

  return (
    <div className="space-y-4">
      {showToggle && (
        <ModeToggle
          mode={effectiveMode}
          dockerCount={volumes.totals.volumeCount}
          k8sCount={pvs.totals.pvCount}
          onChange={(m) => onFiltersChange({ mode: m })}
        />
      )}
      {effectiveMode === 'docker'
        ? <VolumesContent data={volumes} filters={filters} onFiltersChange={onFiltersChange} />
        : <K8sPvsTab data={pvs} filters={filters} onFiltersChange={onFiltersChange} />}
    </div>
  );
}

function ModeToggle({
  mode, dockerCount, k8sCount, onChange,
}: {
  mode: VolumeMode;
  dockerCount: number;
  k8sCount: number;
  onChange: (m: VolumeMode) => void;
}) {
  const btn = (m: VolumeMode, label: string, count: number) => (
    <button
      type="button"
      onClick={() => onChange(m)}
      className={`relative flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
        mode === m
          ? 'border-fg text-fg'
          : 'border-transparent text-muted hover:text-fg'
      }`}
    >
      {label}
      {count > 0 && (
        <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${
          mode === m ? 'bg-fg/10 text-fg' : 'bg-border text-muted'
        }`}>
          {count}
        </span>
      )}
    </button>
  );
  return (
    <div role="tablist" className="flex items-center gap-1 border-b border-border">
      {btn('docker', 'Docker volumes', dockerCount)}
      {btn('k8s', 'Kubernetes PVs', k8sCount)}
    </div>
  );
}

function VolumesContent({
  data, filters, onFiltersChange,
}: {
  data: VolumesOverview;
  filters: VolumeFilters;
  onFiltersChange: (patch: Partial<VolumeFilters>) => void;
}) {
  const dockerHosts = useMemo(
    () => data.hosts.filter(h => h.runtimeType !== 'kubernetes'),
    [data.hosts],
  );

  const hostFacets = useMemo(() =>
    dockerHosts
      .filter(h => h.volumes.length > 0)
      .map(h => ({ id: h.hostId, label: h.hostId, count: h.volumes.length })),
    [dockerHosts],
  );

  const driverFacets = useMemo(() => {
    const counts = new Map<string, number>();
    for (const h of dockerHosts) for (const v of h.volumes) {
      counts.set(v.driver, (counts.get(v.driver) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([id, count]) => ({ id, label: id, count }))
      .sort((a, b) => b.count - a.count);
  }, [dockerHosts]);

  const stateItems: { id: VolumeStateFilter; label: string; count: number }[] = useMemo(() => {
    let orphaned = 0, inUse = 0, total = 0;
    for (const h of dockerHosts) for (const v of h.volumes) {
      total++;
      if (v.refCount === 0) orphaned++;
      else if (v.refCount != null && v.refCount > 0) inUse++;
    }
    return [
      { id: 'all', label: 'All', count: total },
      { id: 'in-use', label: 'In use', count: inUse },
      { id: 'orphaned', label: 'Orphaned', count: orphaned },
    ];
  }, [dockerHosts]);

  const filteredHosts = useMemo(() => {
    const hostSet = new Set(filters.hosts);
    const driverSet = new Set(filters.drivers);
    return dockerHosts
      .filter(h => hostSet.size === 0 || hostSet.has(h.hostId))
      .map(h => ({
        ...h,
        volumes: h.volumes.filter(v => {
          if (driverSet.size > 0 && !driverSet.has(v.driver)) return false;
          if (filters.state === 'orphaned' && v.refCount !== 0) return false;
          if (filters.state === 'in-use' && (v.refCount == null || v.refCount === 0)) return false;
          return true;
        }),
      }))
      .filter(h => h.volumes.length > 0);
  }, [dockerHosts, filters]);

  const toggleList = (list: string[], id: string): string[] =>
    list.includes(id) ? list.filter(x => x !== id) : [...list, id];

  const { totals } = data;

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-[200px_1fr]">
      <aside className="pt-1">
        <FacetGroup
          title="State"
          items={stateItems}
          selected={[filters.state]}
          onToggle={(id) => onFiltersChange({ state: id as VolumeStateFilter })}
          single
        />
        {hostFacets.length > 1 && (
          <FacetGroup
            title="Host"
            items={hostFacets}
            selected={filters.hosts}
            onToggle={(id) => onFiltersChange({ hosts: toggleList(filters.hosts, id) })}
          />
        )}
        {driverFacets.length > 1 && (
          <FacetGroup
            title="Driver"
            items={driverFacets}
            selected={filters.drivers}
            onToggle={(id) => onFiltersChange({ drivers: toggleList(filters.drivers, id) })}
          />
        )}
      </aside>

      <div className="min-w-0 space-y-4">
        {totals.orphanedCount > 0 && (
          <OrphanedBanner
            count={totals.orphanedCount}
            sizeBytes={totals.orphanedSizeBytes}
            onClick={() => onFiltersChange({ state: 'orphaned' })}
            active={filters.state === 'orphaned'}
          />
        )}

        <div className="flex items-center justify-between text-xs text-muted">
          <span>
            <span className="font-semibold text-fg tabular-nums">{totals.volumeCount}</span> volume{totals.volumeCount === 1 ? '' : 's'}
            {' · '}
            <span className="font-semibold text-fg">{fmtBytes(totals.totalSizeBytes)}</span> total
          </span>
        </div>

        {filteredHosts.length === 0 && dockerHosts.some(h => h.volumes.length > 0) && (
          <div className="rounded-xl border border-border bg-surface">
            <EmptyState message="No volumes match these filters." />
          </div>
        )}

        {filteredHosts.length === 0 && !dockerHosts.some(h => h.volumes.length > 0) && dockerHosts.length > 0 && (
          <div className="rounded-xl border border-border bg-surface">
            <EmptyState message="No volume data yet — waiting for the next agent collection cycle." />
          </div>
        )}

        {filteredHosts.map(h => (
          <VolumeHostSection key={h.hostId} host={h} />
        ))}
      </div>
    </div>
  );
}

function OrphanedBanner({
  count, sizeBytes, onClick, active,
}: {
  count: number;
  sizeBytes: number;
  onClick: () => void;
  active: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center justify-between gap-3 rounded-xl border bg-surface px-4 py-3 text-left transition-colors border-l-4 ${active ? 'border-warning ring-2 ring-warning/20' : 'border-border border-l-warning hover:bg-bg-secondary'}`}
    >
      <div>
        <div className="text-sm font-medium text-fg">
          <span className="tabular-nums">{count}</span> orphaned volume{count === 1 ? '' : 's'}
        </div>
        <div className="mt-0.5 text-xs text-muted">
          Not attached to any container · reclaimable
        </div>
      </div>
      <div className="text-right">
        <div className="text-sm font-semibold tabular-nums text-warning">{fmtBytes(sizeBytes)}</div>
        <div className="text-xs text-muted">{active ? 'showing only these' : 'click to filter'}</div>
      </div>
    </button>
  );
}

function VolumeHostSection({ host }: { host: VolumesOverviewHost }) {
  const maxSize = useMemo(() => {
    let m = 0;
    for (const v of host.volumes) m = Math.max(m, v.sizeBytes ?? 0);
    return m;
  }, [host.volumes]);

  const sectionTotal = useMemo(() => {
    let size = 0;
    for (const v of host.volumes) size += v.sizeBytes ?? 0;
    return size;
  }, [host.volumes]);

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-surface">
      <header className="flex items-center justify-between gap-3 border-b border-border bg-bg-secondary px-4 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${host.online ? 'bg-success' : 'bg-muted'}`}
            aria-label={host.online ? 'Online' : 'Offline'}
          />
          <span className="truncate text-sm font-semibold text-fg">{host.hostId}</span>
          {host.hostGroup && (
            <span className="rounded bg-border/70 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted">
              {host.hostGroup}
            </span>
          )}
        </div>
        <span className="text-xs tabular-nums text-muted">
          {host.volumes.length} volume{host.volumes.length === 1 ? '' : 's'} · {fmtBytes(sectionTotal)}
        </span>
      </header>

      <div className="grid grid-cols-[1fr_100px_110px_60px_110px_140px] items-center gap-3 border-b border-border px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
        <div>Volume</div>
        <div>Driver</div>
        <div className="text-right">Size</div>
        <div className="text-right">In use</div>
        <div>Created</div>
        <div>Usage</div>
      </div>

      <ul>
        {host.volumes.map(v => (
          <li
            key={v.name}
            className="grid grid-cols-[1fr_100px_110px_60px_110px_140px] items-center gap-3 border-b border-border/50 px-4 py-2.5 last:border-b-0"
          >
            <div className="min-w-0">
              <div className="truncate font-mono text-sm text-fg" title={v.name}>{v.name}</div>
              {v.mountpoint && (
                <div className="truncate text-[11px] text-muted" title={v.mountpoint}>{v.mountpoint}</div>
              )}
            </div>
            <div className="truncate text-sm text-secondary">{v.driver}</div>
            <div className="text-right tabular-nums text-sm text-fg">
              {v.sizeBytes != null ? fmtBytes(v.sizeBytes) : '—'}
            </div>
            <div className="text-right tabular-nums text-sm">
              {v.refCount == null ? (
                <span className="text-muted">—</span>
              ) : v.refCount === 0 ? (
                <span className="text-warning" title="Orphaned — not mounted by any container">0</span>
              ) : (
                <span className="text-fg">{v.refCount}</span>
              )}
            </div>
            <div className="truncate text-xs text-muted" title={v.createdAt ?? undefined}>
              {formatCreated(v.createdAt)}
            </div>
            <div><RelativeBar value={v.sizeBytes ?? 0} max={maxSize} /></div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RelativeBar({ value, max }: { value: number; max: number }) {
  if (max <= 0 || value <= 0) {
    return <div className="h-1.5 w-24 rounded-full bg-border" />;
  }
  const pct = (value / max) * 100;
  return (
    <div className="h-1.5 w-24 rounded-full bg-border">
      <div
        className="h-1.5 rounded-full bg-info transition-all"
        style={{ width: `${Math.min(pct, 100)}%` }}
      />
    </div>
  );
}

function formatCreated(iso: string | null): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!isFinite(t)) return iso;
  const diffDays = (Date.now() - t) / 86_400_000;
  if (diffDays < 1) return '<1d ago';
  if (diffDays < 30) return `${Math.floor(diffDays)}d ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
}
