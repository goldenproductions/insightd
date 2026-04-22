import { useCallback, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { apiAuth } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { useAuth } from '@/context/AuthContext';
import { PageTitle } from '@/components/PageTitle';
import { Tabs } from '@/components/Tabs';
import { StatsGridSkeleton, CardSkeleton } from '@/components/Skeleton';
import { useKeyboardShortcut } from '@/hooks/useKeyboardShortcut';
import type { DisksOverview } from '@/types/api';
import { StorageSummary } from './StorageSummary';
import { DiskWarningsBanner } from './DiskWarningsBanner';
import { HostDisksTab } from './HostDisksTab';
import { ContainerDisksTab, type ContainerFilters, type ContainerSizeRange } from './ContainerDisksTab';
import { VolumesTab, type VolumeFilters, type VolumeStateFilter } from './VolumesTab';

type TabId = 'hosts' | 'containers' | 'volumes';
type SeverityFilter = 'all' | 'warning' | 'critical';

interface HostTabFilters {
  severity: SeverityFilter;
  hosts: string[];
  groups: string[];
}

interface AllFilters {
  host: HostTabFilters;
  container: ContainerFilters;
  volume: VolumeFilters;
}

function readTab(params: URLSearchParams): TabId {
  const t = params.get('tab');
  if (t === 'containers' || t === 'volumes') return t;
  return 'hosts';
}

function readAllFilters(params: URLSearchParams): AllFilters {
  const sev = params.get('severity');
  const severity: SeverityFilter = sev === 'warning' || sev === 'critical' ? sev : 'all';
  const sizeRangeRaw = params.get('cSize');
  const sizeRange: ContainerSizeRange = sizeRangeRaw === 'gt1gb' || sizeRangeRaw === 'gt5gb' || sizeRangeRaw === 'gt20gb'
    ? sizeRangeRaw
    : 'all';
  const volStateRaw = params.get('vState');
  const volState: VolumeStateFilter = volStateRaw === 'orphaned' || volStateRaw === 'in-use' ? volStateRaw : 'all';
  return {
    host: {
      severity,
      hosts: (params.get('hosts') ?? '').split(',').filter(Boolean),
      groups: (params.get('groups') ?? '').split(',').filter(Boolean),
    },
    container: {
      hosts: (params.get('cHosts') ?? '').split(',').filter(Boolean),
      images: (params.get('cImages') ?? '').split(',').filter(Boolean),
      sizeRange,
    },
    volume: {
      hosts: (params.get('vHosts') ?? '').split(',').filter(Boolean),
      drivers: (params.get('vDrivers') ?? '').split(',').filter(Boolean),
      state: volState,
    },
  };
}

function writeParams(tab: TabId, f: AllFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (tab !== 'hosts') p.set('tab', tab);
  if (f.host.severity !== 'all') p.set('severity', f.host.severity);
  if (f.host.hosts.length > 0) p.set('hosts', f.host.hosts.join(','));
  if (f.host.groups.length > 0) p.set('groups', f.host.groups.join(','));
  if (f.container.hosts.length > 0) p.set('cHosts', f.container.hosts.join(','));
  if (f.container.images.length > 0) p.set('cImages', f.container.images.join(','));
  if (f.container.sizeRange !== 'all') p.set('cSize', f.container.sizeRange);
  if (f.volume.hosts.length > 0) p.set('vHosts', f.volume.hosts.join(','));
  if (f.volume.drivers.length > 0) p.set('vDrivers', f.volume.drivers.join(','));
  if (f.volume.state !== 'all') p.set('vState', f.volume.state);
  return p;
}

export function StoragePage() {
  const { token } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = useMemo(() => readTab(searchParams), [searchParams]);
  const filters = useMemo(() => readAllFilters(searchParams), [searchParams]);
  const [focusHostId, setFocusHostId] = useState<string | null>(null);

  const setActiveTab = useCallback((id: string) => {
    setSearchParams(writeParams(id as TabId, filters), { replace: true });
  }, [filters, setSearchParams]);

  const updateHostFilters = useCallback((patch: Partial<HostTabFilters>) => {
    const next: AllFilters = { ...filters, host: { ...filters.host, ...patch } };
    setSearchParams(writeParams(activeTab, next), { replace: true });
  }, [activeTab, filters, setSearchParams]);

  const updateContainerFilters = useCallback((patch: Partial<ContainerFilters>) => {
    const next: AllFilters = { ...filters, container: { ...filters.container, ...patch } };
    setSearchParams(writeParams(activeTab, next), { replace: true });
  }, [activeTab, filters, setSearchParams]);

  const updateVolumeFilters = useCallback((patch: Partial<VolumeFilters>) => {
    const next: AllFilters = { ...filters, volume: { ...filters.volume, ...patch } };
    setSearchParams(writeParams(activeTab, next), { replace: true });
  }, [activeTab, filters, setSearchParams]);

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: queryKeys.disks(),
    queryFn: () => apiAuth<DisksOverview>('GET', '/disks', undefined, token),
    enabled: !!token,
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  useKeyboardShortcut({ keys: 'r', description: 'Refresh storage', scope: 'Storage', onTrigger: () => { refetch(); } });
  useKeyboardShortcut({ keys: '1', description: 'Hosts tab', scope: 'Storage', onTrigger: () => setActiveTab('hosts') });
  useKeyboardShortcut({ keys: '2', description: 'Containers tab', scope: 'Storage', onTrigger: () => setActiveTab('containers') });
  useKeyboardShortcut({ keys: '3', description: 'Volumes tab', scope: 'Storage', onTrigger: () => setActiveTab('volumes') });

  const mountCount = useMemo(
    () => data?.hosts.reduce((acc, h) => acc + h.mounts.length, 0) ?? 0,
    [data],
  );

  const handleSelectHost = useCallback((hostId: string) => {
    setSearchParams(writeParams('hosts', filters), { replace: true });
    setFocusHostId(hostId);
    requestAnimationFrame(() => {
      const el = document.getElementById(`storage-host-${hostId}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    window.setTimeout(() => setFocusHostId(null), 2000);
  }, [filters, setSearchParams]);

  const tabs = useMemo(() => [
    { id: 'hosts',      label: 'Hosts',      count: data?.hosts.length ?? 0, shortcut: '1' },
    { id: 'containers', label: 'Containers',                                 shortcut: '2' },
    { id: 'volumes',    label: 'Volumes',                                    shortcut: '3' },
  ], [data]);

  return (
    <>
      <PageTitle subtitle="Fleet-wide disk usage, growth forecasts, and capacity warnings.">Storage</PageTitle>

      {isLoading || !data ? (
        <div className="space-y-4">
          <StatsGridSkeleton count={3} />
          <CardSkeleton lines={6} />
        </div>
      ) : (
        <div className="space-y-4">
          <StorageSummary totals={data.totals} mountCount={mountCount} hostCount={data.hosts.length} />

          {data.warnings.length > 0 && (
            <DiskWarningsBanner warnings={data.warnings} onSelectHost={handleSelectHost} />
          )}

          <div className="flex items-center justify-between">
            <Tabs tabs={tabs} active={activeTab} onChange={setActiveTab} />
            <button
              type="button"
              onClick={() => refetch()}
              disabled={isFetching}
              className="text-xs text-muted transition-colors hover:text-fg disabled:opacity-50"
            >
              {isFetching ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>

          {activeTab === 'hosts' && (
            <HostDisksTab
              hosts={data.hosts}
              filters={filters.host}
              onFiltersChange={updateHostFilters}
              focusHostId={focusHostId}
            />
          )}
          {activeTab === 'containers' && (
            <ContainerDisksTab
              isActive={activeTab === 'containers'}
              filters={filters.container}
              onFiltersChange={updateContainerFilters}
            />
          )}
          {activeTab === 'volumes' && (
            <VolumesTab
              isActive={activeTab === 'volumes'}
              filters={filters.volume}
              onFiltersChange={updateVolumeFilters}
            />
          )}
        </div>
      )}
    </>
  );
}
