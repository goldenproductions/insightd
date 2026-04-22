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
import { StorageOverview } from './StorageOverview';
import { HostDisksTab } from './HostDisksTab';
import { VolumesTab, type VolumeFilters, type VolumeStateFilter, type VolumeMode, type PvPhaseFilter, type PvStateFilter } from './VolumesTab';

const PV_PHASE_ALL = ['Bound', 'Available', 'Released', 'Pending', 'Failed'] as const;

type TabId = 'hosts' | 'volumes';
type SeverityFilter = 'all' | 'warning' | 'critical';

interface HostTabFilters {
  severity: SeverityFilter;
  hosts: string[];
  groups: string[];
}

interface AllFilters {
  host: HostTabFilters;
  volume: VolumeFilters;
}

function readTab(params: URLSearchParams): TabId {
  const t = params.get('tab');
  if (t === 'volumes') return 'volumes';
  return 'hosts';
}

function readAllFilters(params: URLSearchParams): AllFilters {
  const sev = params.get('severity');
  const severity: SeverityFilter = sev === 'warning' || sev === 'critical' ? sev : 'all';
  const volStateRaw = params.get('vState');
  const volState: VolumeStateFilter = volStateRaw === 'orphaned' || volStateRaw === 'in-use' ? volStateRaw : 'all';
  const modeRaw = params.get('vMode');
  const mode: VolumeMode = modeRaw === 'k8s' ? 'k8s' : 'docker';
  const pvStateRaw = params.get('vPvState');
  const pvState: PvStateFilter = pvStateRaw === 'orphaned' ? 'orphaned' : 'all';
  const phases = (params.get('vPhases') ?? '').split(',')
    .filter((x): x is PvPhaseFilter => (PV_PHASE_ALL as readonly string[]).includes(x));
  return {
    host: {
      severity,
      hosts: (params.get('hosts') ?? '').split(',').filter(Boolean),
      groups: (params.get('groups') ?? '').split(',').filter(Boolean),
    },
    volume: {
      mode,
      hosts: (params.get('vHosts') ?? '').split(',').filter(Boolean),
      drivers: (params.get('vDrivers') ?? '').split(',').filter(Boolean),
      state: volState,
      clusters: (params.get('vClusters') ?? '').split(',').filter(Boolean),
      phases,
      storageClasses: (params.get('vSClasses') ?? '').split(',').filter(Boolean),
      pvState,
    },
  };
}

function writeParams(tab: TabId, f: AllFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (tab !== 'hosts') p.set('tab', tab);
  if (f.host.severity !== 'all') p.set('severity', f.host.severity);
  if (f.host.hosts.length > 0) p.set('hosts', f.host.hosts.join(','));
  if (f.host.groups.length > 0) p.set('groups', f.host.groups.join(','));
  if (f.volume.mode !== 'docker') p.set('vMode', f.volume.mode);
  if (f.volume.hosts.length > 0) p.set('vHosts', f.volume.hosts.join(','));
  if (f.volume.drivers.length > 0) p.set('vDrivers', f.volume.drivers.join(','));
  if (f.volume.state !== 'all') p.set('vState', f.volume.state);
  if (f.volume.clusters.length > 0) p.set('vClusters', f.volume.clusters.join(','));
  if (f.volume.phases.length > 0) p.set('vPhases', f.volume.phases.join(','));
  if (f.volume.storageClasses.length > 0) p.set('vSClasses', f.volume.storageClasses.join(','));
  if (f.volume.pvState !== 'all') p.set('vPvState', f.volume.pvState);
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

  const updateVolumeFilters = useCallback((patch: Partial<VolumeFilters>) => {
    const next: AllFilters = { ...filters, volume: { ...filters.volume, ...patch } };
    setSearchParams(writeParams(activeTab, next), { replace: true });
  }, [activeTab, filters, setSearchParams]);

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: queryKeys.disks(),
    queryFn: () => apiAuth<DisksOverview>('GET', '/disks', undefined, token),
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  useKeyboardShortcut({ keys: 'r', description: 'Refresh storage', scope: 'Storage', onTrigger: () => { refetch(); } });
  useKeyboardShortcut({ keys: '1', description: 'Hosts tab', scope: 'Storage', onTrigger: () => setActiveTab('hosts') });
  useKeyboardShortcut({ keys: '2', description: 'Volumes tab', scope: 'Storage', onTrigger: () => setActiveTab('volumes') });

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
    { id: 'hosts',   label: 'Hosts',   count: data?.hosts.length ?? 0, shortcut: '1' },
    { id: 'volumes', label: 'Volumes',                                 shortcut: '2' },
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
          <StorageOverview
            data={data}
            mountCount={mountCount}
            hostCount={data.hosts.length}
            onSelectHost={handleSelectHost}
          />

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
