import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { DiskBar } from '@/components/DiskBar';
import { EmptyState } from '@/components/EmptyState';
import type { DiskOverviewHost, DiskOverviewMount } from '@/types/api';

function fmtGb(gb: number): string {
  if (gb >= 1024) return (gb / 1024).toFixed(2) + ' TB';
  if (gb >= 1) return gb.toFixed(1) + ' GB';
  return (gb * 1024).toFixed(0) + ' MB';
}

type SeverityFilter = 'all' | 'warning' | 'critical';

interface Filters {
  severity: SeverityFilter;
  hosts: string[];
  groups: string[];
}

interface Props {
  hosts: DiskOverviewHost[];
  filters: Filters;
  onFiltersChange: (patch: Partial<Filters>) => void;
  focusHostId: string | null;
}

function mountSeverity(m: DiskOverviewMount): 'critical' | 'warning' | 'ok' {
  if (m.usedPercent >= 90 || (m.daysUntilFull != null && m.daysUntilFull < 7)) return 'critical';
  if (m.usedPercent >= 85 || (m.daysUntilFull != null && m.daysUntilFull < 14)) return 'warning';
  return 'ok';
}

export function HostDisksTab({ hosts, filters, onFiltersChange, focusHostId }: Props) {
  const navigate = useNavigate();

  // Severity counts over *all* mounts (before filtering) so facet counts stay stable.
  const counts = useMemo(() => {
    let critical = 0, warning = 0, total = 0;
    for (const h of hosts) for (const m of h.mounts) {
      total++;
      const s = mountSeverity(m);
      if (s === 'critical') critical++;
      else if (s === 'warning') warning++;
    }
    return { total, critical, warning };
  }, [hosts]);

  const hostFacets = useMemo(() =>
    hosts.map(h => ({ id: h.hostId, count: h.mounts.length })),
    [hosts],
  );

  const groupFacets = useMemo(() => {
    const map = new Map<string, number>();
    for (const h of hosts) {
      const key = h.hostGroup ?? '(ungrouped)';
      map.set(key, (map.get(key) ?? 0) + h.mounts.length);
    }
    return Array.from(map.entries()).map(([id, count]) => ({ id, count })).sort((a, b) => a.id.localeCompare(b.id));
  }, [hosts]);

  const filtered = useMemo(() => {
    const hostFilter = new Set(filters.hosts);
    const groupFilter = new Set(filters.groups);
    return hosts
      .filter(h => hostFilter.size === 0 || hostFilter.has(h.hostId))
      .filter(h => groupFilter.size === 0 || groupFilter.has(h.hostGroup ?? '(ungrouped)'))
      .map(h => ({
        ...h,
        mounts: h.mounts.filter(m => {
          if (filters.severity === 'critical') return mountSeverity(m) === 'critical';
          if (filters.severity === 'warning') {
            const s = mountSeverity(m);
            return s === 'warning' || s === 'critical';
          }
          return true;
        }),
      }))
      .filter(h => h.mounts.length > 0);
  }, [hosts, filters]);

  const toggleList = (list: string[], id: string): string[] =>
    list.includes(id) ? list.filter(x => x !== id) : [...list, id];

  const severityItems: { id: SeverityFilter; label: string; count: number }[] = [
    { id: 'all', label: 'All', count: counts.total },
    { id: 'warning', label: 'Warning+', count: counts.warning + counts.critical },
    { id: 'critical', label: 'Critical', count: counts.critical },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-[200px_1fr]">
      <aside className="pt-1">
        <FacetGroup
          title="Severity"
          items={severityItems}
          selected={[filters.severity]}
          onToggle={(id) => onFiltersChange({ severity: id as SeverityFilter })}
          single
        />
        {hostFacets.length > 1 && (
          <FacetGroup
            title="Host"
            items={hostFacets.map(h => ({ id: h.id, label: h.id, count: h.count }))}
            selected={filters.hosts}
            onToggle={(id) => onFiltersChange({ hosts: toggleList(filters.hosts, id) })}
          />
        )}
        {groupFacets.length > 1 && (
          <FacetGroup
            title="Group"
            items={groupFacets.map(g => ({ id: g.id, label: g.id, count: g.count }))}
            selected={filters.groups}
            onToggle={(id) => onFiltersChange({ groups: toggleList(filters.groups, id) })}
          />
        )}
      </aside>

      <div className="min-w-0 space-y-4">
        {filtered.length === 0 ? (
          <div className="rounded-xl border border-border bg-surface">
            <EmptyState message={hosts.length === 0 ? 'No disk data yet — agents report disk usage every minute.' : 'No mounts match these filters.'} />
          </div>
        ) : (
          filtered.map(h => (
            <HostSection
              key={h.hostId}
              host={h}
              focused={focusHostId === h.hostId}
              onOpenHost={() => navigate(`/hosts/${encodeURIComponent(h.hostId)}`)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function HostSection({ host, focused, onOpenHost }: { host: DiskOverviewHost; focused: boolean; onOpenHost: () => void }) {
  return (
    <section
      id={`storage-host-${host.hostId}`}
      className={`overflow-hidden rounded-xl border bg-surface transition-colors ${focused ? 'border-info' : 'border-border'}`}
    >
      <header className="flex items-center justify-between gap-3 border-b border-border bg-bg-secondary px-4 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`h-2 w-2 shrink-0 rounded-full ${host.online ? 'bg-success' : 'bg-muted'}`} aria-label={host.online ? 'Online' : 'Offline'} />
          <button
            type="button"
            onClick={onOpenHost}
            className="truncate text-sm font-semibold text-fg hover:text-info"
          >
            {host.hostId}
          </button>
          {host.hostGroup && (
            <span className="rounded bg-border/70 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted">
              {host.hostGroup}
            </span>
          )}
        </div>
        <span className="text-xs tabular-nums text-muted">
          {host.mounts.length} mount{host.mounts.length === 1 ? '' : 's'}
        </span>
      </header>

      <div className="grid grid-cols-[1fr_110px_110px_140px_180px] items-center gap-3 border-b border-border px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
        <div>Mount</div>
        <div className="text-right">Used</div>
        <div className="text-right">Free</div>
        <div className="text-right">Total</div>
        <div>Usage</div>
      </div>

      <ul>
        {host.mounts.map(m => (
          <li key={m.mountPoint} className="grid grid-cols-[1fr_110px_110px_140px_180px] items-center gap-3 border-b border-border/50 px-4 py-2.5 last:border-b-0">
            <div className="min-w-0">
              <div className="truncate font-mono text-sm text-fg">{m.mountPoint}</div>
              <ForecastLine mount={m} />
            </div>
            <div className="text-right tabular-nums text-sm text-fg">{fmtGb(m.usedGb)}</div>
            <div className="text-right tabular-nums text-sm text-secondary">{fmtGb(m.freeGb)}</div>
            <div className="text-right tabular-nums text-sm text-muted">{fmtGb(m.totalGb)}</div>
            <div><DiskBar percent={m.usedPercent} /></div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ForecastLine({ mount }: { mount: DiskOverviewMount }) {
  if (mount.daysUntilFull != null && mount.daysUntilFull < 14) {
    const color = mount.daysUntilFull < 7 ? 'text-danger' : 'text-warning';
    return <div className={`text-xs ${color}`}>~{mount.daysUntilFull}d until full · +{mount.dailyGrowthGb}GB/day</div>;
  }
  if (mount.dailyGrowthGb > 0) {
    return <div className="text-xs text-muted">Stable · +{mount.dailyGrowthGb}GB/day</div>;
  }
  return null;
}

// ─────────── Facet primitive ───────────

interface FacetItem { id: string; label: string; count: number }

function FacetGroup({
  title, items, selected, onToggle, single = false,
}: {
  title: string;
  items: FacetItem[];
  selected: string[];
  onToggle: (id: string) => void;
  single?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mb-5">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted">{title}</div>
      <ul className="space-y-1.5">
        {items.map(it => {
          const on = selected.includes(it.id);
          return (
            <li key={it.id}>
              <label className="group flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type={single ? 'radio' : 'checkbox'}
                  name={single ? title : undefined}
                  checked={on}
                  onChange={() => onToggle(it.id)}
                  className="h-3.5 w-3.5 cursor-pointer"
                />
                <span className={`min-w-0 flex-1 truncate ${on ? 'font-medium text-fg' : 'text-secondary group-hover:text-fg'}`}>
                  {it.label}
                </span>
                <span className="text-[11px] tabular-nums text-muted">{it.count}</span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
