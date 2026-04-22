import { useMemo } from 'react';
import { EmptyState } from '@/components/EmptyState';
import { fmtBytes } from '@/lib/formatters';
import type { PvsOverview, PvsOverviewCluster, PvItem } from '@/types/api';
import { FacetGroup } from './FacetGroup';
import type { VolumeFilters, PvPhaseFilter, PvStateFilter } from './VolumesTab';

interface Props {
  data: PvsOverview;
  filters: VolumeFilters;
  onFiltersChange: (patch: Partial<VolumeFilters>) => void;
}

const PHASE_ORDER: PvPhaseFilter[] = ['Bound', 'Available', 'Released', 'Pending', 'Failed'];

export function K8sPvsTab({ data, filters, onFiltersChange }: Props) {
  const { clusters, totals } = data;

  const clusterFacets = useMemo(() =>
    clusters
      .filter(c => c.pvs.length > 0 || c.pvcs.length > 0)
      .map(c => ({ id: c.clusterId, label: c.clusterId, count: c.pvs.length })),
    [clusters],
  );

  const phaseFacets = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of clusters) for (const pv of c.pvs) {
      counts.set(pv.phase, (counts.get(pv.phase) ?? 0) + 1);
    }
    return PHASE_ORDER
      .filter(p => counts.has(p))
      .map(p => ({ id: p, label: p, count: counts.get(p) ?? 0 }));
  }, [clusters]);

  const storageClassFacets = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of clusters) for (const pv of c.pvs) {
      const sc = pv.storageClass ?? '<none>';
      counts.set(sc, (counts.get(sc) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([id, count]) => ({ id, label: id, count }))
      .sort((a, b) => b.count - a.count);
  }, [clusters]);

  const stateItems: { id: PvStateFilter; label: string; count: number }[] = useMemo(() => [
    { id: 'all',      label: 'All',       count: totals.pvCount },
    { id: 'orphaned', label: 'Released',  count: totals.orphanedCount },
  ], [totals]);

  const filteredClusters = useMemo(() => {
    const clusterSet = new Set(filters.clusters);
    const phaseSet = new Set(filters.phases);
    const scSet = new Set(filters.storageClasses);
    return clusters
      .filter(c => clusterSet.size === 0 || clusterSet.has(c.clusterId))
      .map(c => ({
        ...c,
        pvs: c.pvs.filter(pv => {
          if (phaseSet.size > 0 && !phaseSet.has(pv.phase as PvPhaseFilter)) return false;
          const sc = pv.storageClass ?? '<none>';
          if (scSet.size > 0 && !scSet.has(sc)) return false;
          if (filters.pvState === 'orphaned' && !pv.orphaned) return false;
          return true;
        }),
      }))
      .filter(c => c.pvs.length > 0 || (filters.clusters.includes(c.clusterId) && c.pvcs.length > 0));
  }, [clusters, filters]);

  const toggleList = <T extends string>(list: T[], id: T): T[] =>
    list.includes(id) ? list.filter(x => x !== id) : [...list, id];

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-[200px_1fr]">
      <aside className="pt-1">
        <FacetGroup
          title="State"
          items={stateItems}
          selected={[filters.pvState]}
          onToggle={(id) => onFiltersChange({ pvState: id as PvStateFilter })}
          single
        />
        {clusterFacets.length > 1 && (
          <FacetGroup
            title="Cluster"
            items={clusterFacets}
            selected={filters.clusters}
            onToggle={(id) => onFiltersChange({ clusters: toggleList(filters.clusters, id) })}
          />
        )}
        {phaseFacets.length > 1 && (
          <FacetGroup
            title="Phase"
            items={phaseFacets}
            selected={filters.phases}
            onToggle={(id) => onFiltersChange({ phases: toggleList(filters.phases, id as PvPhaseFilter) })}
          />
        )}
        {storageClassFacets.length > 1 && (
          <FacetGroup
            title="Storage class"
            items={storageClassFacets}
            selected={filters.storageClasses}
            onToggle={(id) => onFiltersChange({ storageClasses: toggleList(filters.storageClasses, id) })}
          />
        )}
      </aside>

      <div className="min-w-0 space-y-4">
        {totals.clusterCount === 0 && (
          <div className="rounded-xl border border-dashed border-border bg-surface p-6">
            <EmptyState message="No Kubernetes PV data yet — the agent publishes every 5 minutes once elected as leader." />
            <p className="mt-3 text-center text-xs text-muted">
              See <code className="rounded bg-bg-secondary px-1.5 py-0.5">docs/kubernetes-setup.md</code> for setup.
            </p>
          </div>
        )}

        {totals.orphanedCount > 0 && (
          <OrphanedBanner
            count={totals.orphanedCount}
            sizeBytes={totals.orphanedCapacityBytes}
            onClick={() => onFiltersChange({ pvState: filters.pvState === 'orphaned' ? 'all' : 'orphaned' })}
            active={filters.pvState === 'orphaned'}
          />
        )}

        {totals.pvCount > 0 && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
            <span>
              <span className="font-semibold text-fg tabular-nums">{totals.pvCount}</span> PV{totals.pvCount === 1 ? '' : 's'}
              {' · '}
              <span className="font-semibold text-fg">{fmtBytes(totals.totalCapacityBytes)}</span> total
            </span>
            <span>
              <span className="font-semibold text-fg tabular-nums">{totals.pvcCount}</span> PVC{totals.pvcCount === 1 ? '' : 's'}
              {totals.pvcPendingCount > 0 && (
                <span className="text-warning"> · {totals.pvcPendingCount} pending</span>
              )}
            </span>
            <span>
              <span className="font-semibold text-fg tabular-nums">{totals.clusterCount}</span> cluster{totals.clusterCount === 1 ? '' : 's'}
            </span>
          </div>
        )}

        {filteredClusters.length === 0 && totals.pvCount > 0 && (
          <div className="rounded-xl border border-border bg-surface">
            <EmptyState message="No PVs match these filters." />
          </div>
        )}

        {filteredClusters.map(c => (
          <PvClusterSection key={c.clusterId} cluster={c} />
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
          <span className="tabular-nums">{count}</span> released PV{count === 1 ? '' : 's'}
        </div>
        <div className="mt-0.5 text-xs text-muted">
          Not bound to a claim · reclaim policy determines whether disk is freed
        </div>
      </div>
      <div className="text-right">
        <div className="text-sm font-semibold tabular-nums text-warning">{fmtBytes(sizeBytes)}</div>
        <div className="text-xs text-muted">{active ? 'showing only these' : 'click to filter'}</div>
      </div>
    </button>
  );
}

function PvClusterSection({ cluster }: { cluster: PvsOverviewCluster }) {
  const maxCapacity = useMemo(() => {
    let m = 0;
    for (const pv of cluster.pvs) m = Math.max(m, pv.capacityBytes ?? 0);
    return m;
  }, [cluster.pvs]);

  const sectionTotal = useMemo(() => {
    let size = 0;
    for (const pv of cluster.pvs) size += pv.capacityBytes ?? 0;
    return size;
  }, [cluster.pvs]);

  const pendingPvcs = cluster.pvcs.filter(p => p.phase === 'Pending');

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-surface">
      <header className="flex items-center justify-between gap-3 border-b border-border bg-bg-secondary px-4 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${cluster.online ? 'bg-success' : 'bg-muted'}`}
            aria-label={cluster.online ? 'Online' : 'Stale'}
          />
          <span className="truncate text-sm font-semibold text-fg">{cluster.clusterId}</span>
          {!cluster.online && cluster.lastCollectedAt && (
            <span className="rounded bg-border/70 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted">
              stale · last {formatRelative(cluster.lastCollectedAt)}
            </span>
          )}
        </div>
        <span className="text-xs tabular-nums text-muted">
          {cluster.pvs.length} PV{cluster.pvs.length === 1 ? '' : 's'} · {fmtBytes(sectionTotal)}
        </span>
      </header>

      {pendingPvcs.length > 0 && (
        <div className="border-b border-border bg-warning/5 px-4 py-2 text-xs">
          <span className="font-medium text-warning">{pendingPvcs.length} pending PVC{pendingPvcs.length === 1 ? '' : 's'}</span>
          <span className="text-muted"> — </span>
          <span className="text-muted">
            {pendingPvcs.slice(0, 3).map(p => `${p.namespace}/${p.name}`).join(', ')}
            {pendingPvcs.length > 3 && `, +${pendingPvcs.length - 3} more`}
          </span>
        </div>
      )}

      <div className="grid grid-cols-[1fr_110px_110px_1fr_110px_140px] items-center gap-3 border-b border-border px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
        <div>PV</div>
        <div>Phase</div>
        <div className="text-right">Capacity</div>
        <div>Bound claim</div>
        <div>Storage class</div>
        <div>Usage</div>
      </div>

      <ul>
        {cluster.pvs.map(pv => (
          <PvRow key={pv.name} pv={pv} maxCapacity={maxCapacity} />
        ))}
      </ul>
    </section>
  );
}

function PvRow({ pv, maxCapacity }: { pv: PvItem; maxCapacity: number }) {
  return (
    <li className="grid grid-cols-[1fr_110px_110px_1fr_110px_140px] items-center gap-3 border-b border-border/50 px-4 py-2.5 last:border-b-0">
      <div className="min-w-0">
        <div className="truncate font-mono text-sm text-fg" title={pv.name}>{pv.name}</div>
        <div className="flex items-center gap-2 text-[11px] text-muted">
          {pv.accessModes.length > 0 && (
            <span>{pv.accessModes.map(shortAccessMode).join(', ')}</span>
          )}
          {pv.csiDriver && <span className="truncate" title={pv.csiDriver}>· {pv.csiDriver}</span>}
          {pv.reclaimPolicy && pv.reclaimPolicy !== 'Delete' && (
            <span title={`Reclaim policy: ${pv.reclaimPolicy}`}>· {pv.reclaimPolicy}</span>
          )}
        </div>
      </div>
      <div><PhaseBadge phase={pv.phase} orphaned={pv.orphaned} /></div>
      <div className="text-right tabular-nums text-sm text-fg">
        {pv.capacityBytes != null ? fmtBytes(pv.capacityBytes) : '—'}
      </div>
      <div className="min-w-0 text-sm">
        {pv.boundPvc ? (
          <div className="truncate" title={`${pv.boundPvc.namespace}/${pv.boundPvc.name}`}>
            <span className="text-muted">{pv.boundPvc.namespace}</span>
            <span className="text-muted">/</span>
            <span className="text-fg">{pv.boundPvc.name}</span>
          </div>
        ) : pv.claimRef ? (
          <div className="truncate text-muted" title={`${pv.claimRef.namespace}/${pv.claimRef.name} (not found)`}>
            <span>{pv.claimRef.namespace}/{pv.claimRef.name}</span>
            <span className="ml-1 text-[11px]">(missing)</span>
          </div>
        ) : (
          <span className="text-muted">—</span>
        )}
      </div>
      <div className="truncate text-sm text-secondary">{pv.storageClass ?? <span className="text-muted">—</span>}</div>
      <div><RelativeBar value={pv.capacityBytes ?? 0} max={maxCapacity} /></div>
    </li>
  );
}

function PhaseBadge({ phase, orphaned }: { phase: string; orphaned: boolean }) {
  const style = phaseStyle(phase, orphaned);
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ${style}`}>
      {phase}
    </span>
  );
}

function phaseStyle(phase: string, orphaned: boolean): string {
  if (orphaned) return 'bg-warning/15 text-warning';
  switch (phase) {
    case 'Bound':     return 'bg-success/15 text-success';
    case 'Available': return 'bg-info/15 text-info';
    case 'Pending':   return 'bg-warning/15 text-warning';
    case 'Failed':    return 'bg-danger/15 text-danger';
    default:          return 'bg-border text-muted';
  }
}

function shortAccessMode(m: string): string {
  // Standard short forms used by kubectl.
  if (m === 'ReadWriteOnce')      return 'RWO';
  if (m === 'ReadWriteOncePod')   return 'RWOP';
  if (m === 'ReadOnlyMany')       return 'ROX';
  if (m === 'ReadWriteMany')      return 'RWX';
  return m;
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

function formatRelative(sqliteTs: string): string {
  // SQLite datetime('now') returns "YYYY-MM-DD HH:MM:SS" (UTC, no zone).
  const iso = sqliteTs.includes('T') ? sqliteTs : sqliteTs.replace(' ', 'T') + 'Z';
  const t = Date.parse(iso);
  if (!isFinite(t)) return sqliteTs;
  const diffMin = (Date.now() - t) / 60_000;
  if (diffMin < 1)   return 'just now';
  if (diffMin < 60)  return `${Math.floor(diffMin)}m ago`;
  if (diffMin < 1440) return `${Math.floor(diffMin / 60)}h ago`;
  return `${Math.floor(diffMin / 1440)}d ago`;
}
