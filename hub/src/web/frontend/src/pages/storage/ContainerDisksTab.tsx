import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiAuth } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { useAuth } from '@/context/AuthContext';
import { useShowInternal } from '@/hooks/useShowInternal';
import { EmptyState } from '@/components/EmptyState';
import { CardSkeleton } from '@/components/Skeleton';
import { fmtBytes } from '@/lib/formatters';
import type { ContainersStorage, ContainersStorageHost, ContainerStorageItem } from '@/types/api';
import { FacetGroup } from './FacetGroup';

export type ContainerSizeRange = 'all' | 'gt1gb' | 'gt5gb' | 'gt20gb';

export interface ContainerFilters {
  hosts: string[];
  images: string[];
  sizeRange: ContainerSizeRange;
}

interface Props {
  isActive: boolean;
  filters: ContainerFilters;
  onFiltersChange: (patch: Partial<ContainerFilters>) => void;
}

const SIZE_THRESHOLDS: Record<ContainerSizeRange, number> = {
  all: 0,
  gt1gb: 1 * 1024 ** 3,
  gt5gb: 5 * 1024 ** 3,
  gt20gb: 20 * 1024 ** 3,
};

function containerSize(c: ContainerStorageItem): number {
  return c.sizeRwBytes ?? c.sizeRootfsBytes ?? 0;
}

export function ContainerDisksTab({ isActive, filters, onFiltersChange }: Props) {
  const { token } = useAuth();
  const { showInternal } = useShowInternal();

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.containersStorage(showInternal),
    queryFn: () => apiAuth<ContainersStorage>(
      'GET',
      `/containers-storage${showInternal ? '?showInternal=true' : ''}`,
      undefined,
      token,
    ),
    enabled: isActive && !!token,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  if (isLoading || !data) {
    return <CardSkeleton lines={8} />;
  }

  return <ContainerDisksContent data={data} filters={filters} onFiltersChange={onFiltersChange} />;
}

function ContainerDisksContent({
  data, filters, onFiltersChange,
}: {
  data: ContainersStorage;
  filters: ContainerFilters;
  onFiltersChange: (patch: Partial<ContainerFilters>) => void;
}) {
  const navigate = useNavigate();

  const hostFacets = useMemo(() =>
    data.hosts.map(h => ({ id: h.hostId, label: h.hostId, count: h.containers.length })),
    [data.hosts],
  );

  const imageFacets = useMemo(() => {
    const counts = new Map<string, number>();
    for (const h of data.hosts) for (const c of h.containers) {
      const img = c.image || '(unknown)';
      counts.set(img, (counts.get(img) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([id, count]) => ({ id, label: id, count }))
      .sort((a, b) => b.count - a.count);
  }, [data.hosts]);

  const sizeItems: { id: ContainerSizeRange; label: string; count: number }[] = useMemo(() => {
    const ranges: ContainerSizeRange[] = ['all', 'gt1gb', 'gt5gb', 'gt20gb'];
    const labels: Record<ContainerSizeRange, string> = {
      all: 'All',
      gt1gb: '> 1 GB',
      gt5gb: '> 5 GB',
      gt20gb: '> 20 GB',
    };
    return ranges.map(r => {
      const threshold = SIZE_THRESHOLDS[r];
      let count = 0;
      for (const h of data.hosts) for (const c of h.containers) {
        if (containerSize(c) > threshold || r === 'all') count++;
      }
      return { id: r, label: labels[r], count };
    });
  }, [data.hosts]);

  const filtered = useMemo(() => {
    const hostSet = new Set(filters.hosts);
    const imageSet = new Set(filters.images);
    const sizeMin = SIZE_THRESHOLDS[filters.sizeRange];
    return data.hosts
      .filter(h => hostSet.size === 0 || hostSet.has(h.hostId))
      .map(h => ({
        ...h,
        containers: h.containers.filter(c => {
          if (imageSet.size > 0 && !imageSet.has(c.image || '(unknown)')) return false;
          if (sizeMin > 0 && containerSize(c) <= sizeMin) return false;
          return true;
        }),
      }))
      .filter(h => h.containers.length > 0);
  }, [data.hosts, filters]);

  const filteredTotals = useMemo(() => {
    let count = 0, rw = 0, rootfs = 0;
    for (const h of filtered) for (const c of h.containers) {
      count++;
      rw += c.sizeRwBytes ?? 0;
      rootfs += c.sizeRootfsBytes ?? 0;
    }
    return { count, rw, rootfs };
  }, [filtered]);

  const toggleList = (list: string[], id: string): string[] =>
    list.includes(id) ? list.filter(x => x !== id) : [...list, id];

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-[200px_1fr]">
      <aside className="pt-1">
        <FacetGroup
          title="Size"
          items={sizeItems}
          selected={[filters.sizeRange]}
          onToggle={(id) => onFiltersChange({ sizeRange: id as ContainerSizeRange })}
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
        {imageFacets.length > 1 && (
          <FacetGroup
            title="Image"
            items={imageFacets.slice(0, 25)}
            selected={filters.images}
            onToggle={(id) => onFiltersChange({ images: toggleList(filters.images, id) })}
          />
        )}
      </aside>

      <div className="min-w-0 space-y-4">
        <div className="flex items-center justify-between text-xs text-muted">
          <span>
            <span className="font-semibold text-fg tabular-nums">{filteredTotals.count}</span> container{filteredTotals.count === 1 ? '' : 's'}
            {' · '}
            <span className="font-semibold text-fg">{fmtBytes(filteredTotals.rw)}</span> writable
            {filteredTotals.rootfs > 0 && <> · <span className="font-semibold text-fg">{fmtBytes(filteredTotals.rootfs)}</span> rootfs</>}
          </span>
        </div>

        {filtered.length === 0 ? (
          <div className="rounded-xl border border-border bg-surface">
            <EmptyState
              message={
                data.hosts.length === 0
                  ? 'No container size data yet — waiting for the next agent collection cycle.'
                  : 'No containers match these filters.'
              }
            />
          </div>
        ) : (
          filtered.map(h => (
            <ContainerHostSection
              key={h.hostId}
              host={h}
              onOpenContainer={(name) => navigate(`/hosts/${encodeURIComponent(h.hostId)}/containers/${encodeURIComponent(name)}`)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function ContainerHostSection({
  host, onOpenContainer,
}: {
  host: ContainersStorageHost;
  onOpenContainer: (name: string) => void;
}) {
  const maxSize = useMemo(() => {
    let m = 0;
    for (const c of host.containers) m = Math.max(m, containerSize(c));
    return m;
  }, [host.containers]);

  const sectionTotal = useMemo(() => {
    let rw = 0, rootfs = 0;
    for (const c of host.containers) {
      rw += c.sizeRwBytes ?? 0;
      rootfs += c.sizeRootfsBytes ?? 0;
    }
    return { rw, rootfs };
  }, [host.containers]);

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
          {host.containers.length} container{host.containers.length === 1 ? '' : 's'}
          {' · '}
          {fmtBytes(sectionTotal.rw)} writable
        </span>
      </header>

      <div className="grid grid-cols-[1fr_1fr_110px_110px_180px] items-center gap-3 border-b border-border px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
        <div>Container</div>
        <div>Image</div>
        <div className="text-right">Writable</div>
        <div className="text-right">Rootfs</div>
        <div>Usage</div>
      </div>

      <ul>
        {host.containers.map(c => (
          <li
            key={c.name}
            className="grid grid-cols-[1fr_1fr_110px_110px_180px] items-center gap-3 border-b border-border/50 px-4 py-2.5 last:border-b-0"
          >
            <div className="min-w-0">
              <button
                type="button"
                onClick={() => onOpenContainer(c.name)}
                className="truncate font-mono text-sm text-fg hover:text-info"
              >
                {c.name}
              </button>
              {c.status !== 'running' && (
                <span className="ml-2 text-[10px] uppercase tracking-wider text-muted">{c.status}</span>
              )}
            </div>
            <div className="truncate text-sm text-secondary" title={c.image ?? undefined}>
              {c.image ?? '—'}
            </div>
            <div className="text-right tabular-nums text-sm text-fg">
              {c.sizeRwBytes != null ? fmtBytes(c.sizeRwBytes) : '—'}
            </div>
            <div className="text-right tabular-nums text-sm text-muted">
              {c.sizeRootfsBytes != null ? fmtBytes(c.sizeRootfsBytes) : '—'}
            </div>
            <div><RelativeBar value={containerSize(c)} max={maxSize} /></div>
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
