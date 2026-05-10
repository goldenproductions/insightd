import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, apiAuth } from '@/lib/api';
import type { HostDetail, HostMetricsSnapshot, Host, TimelineResponse, Trends, EventItem, HostBaselinesResponse, InsightRow } from '@/types/api';
import { StatusDot } from '@/components/StatusDot';
import { Badge } from '@/components/Badge';
import { NodeConditionBadges } from '@/components/NodeConditionBadges';
import { Button, Input } from '@/components/FormField';
import { Tabs } from '@/components/Tabs';
import { BackLink } from '@/components/BackLink';
import { ActionResult } from '@/components/ActionResult';
import { StatsGridSkeleton, CardSkeleton } from '@/components/Skeleton';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useAuth } from '@/context/AuthContext';
import { useContainerAction } from '@/hooks/useContainerAction';
import { useConfirm } from '@/hooks/useConfirm';
import { useKeyboardShortcut } from '@/hooks/useKeyboardShortcut';
import { useState } from 'react';
import { queryKeys } from '@/lib/queryKeys';
import { HostOverviewTab } from './HostOverviewTab';
import { HostResourcesTab } from './HostResourcesTab';
import { HostAlertsTab } from './HostAlertsTab';
import { HostK8sEventsTab } from './HostK8sEventsTab';
import { HostPveTab } from './HostPveTab';
import { AnomaliesList } from '@/components/AnomaliesList';
import { BaselinesViewer } from '@/components/BaselinesViewer';
import { ExploreDrawer } from '@/components/ExploreDrawer';
import { HostUptimeHero } from '@/components/HostUptimeHero';
import { TopologyLinkCard } from '@/components/TopologyLinkCard';
import { HypervisorInfoCard } from '@/components/HypervisorInfoCard';
import { getContainerNamespace } from '@/lib/containers';
import { InsightsTabPanel } from '@/components/insights/InsightsTabPanel';

export function HostDetailPage() {
  const { hostId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { isAuthenticated } = useAuth();
  const hid = encodeURIComponent(hostId!);
  const { confirm, dialogProps } = useConfirm();
  const { actionLoading, actionResult, runAction, removeContainer } = useContainerAction(hostId!, [['host', hostId]], confirm);

  const { data: insights } = useQuery({
    queryKey: queryKeys.hostInsights(hostId),
    queryFn: () => api<InsightRow[]>(`/hosts/${hid}/insights`).catch(() => []),
    refetchInterval: 60_000,
  });

  // Initialise active tab from the ?tab= URL param. We allow 'insights' in
  // the set regardless of whether data has loaded yet — if insights turn out
  // to be empty when data arrives the conditional tab list will exclude the
  // tab and the body render will just be skipped.
  const tabParam = searchParams.get('tab');
  const validTabs = ['overview', 'resources', 'alerts', 'insights', 'k8s-events', 'pve'];
  const initialTab = tabParam && validTabs.includes(tabParam) ? tabParam : 'overview';
  const [activeTab, setActiveTab] = useState(initialTab);

  const handleTabChange = (id: string) => {
    setActiveTab(id);
    setSearchParams({ tab: id }, { replace: true });
  };

  const { data } = useQuery({ queryKey: queryKeys.host(hostId), queryFn: () => api<HostDetail>(`/hosts/${hid}`), refetchInterval: 30_000 });
  const { data: timeline } = useQuery({ queryKey: queryKeys.timeline(hostId), queryFn: () => api<TimelineResponse>(`/hosts/${hid}/timeline?days=7`).catch(() => ({ host: null, containers: [] }) as TimelineResponse) });
  const { data: trends } = useQuery({ queryKey: queryKeys.trends(hostId), queryFn: () => api<Trends>(`/hosts/${hid}/trends`).catch(() => ({ containers: [], host: null })) });
  const { data: events } = useQuery({ queryKey: queryKeys.events(hostId), queryFn: () => api<EventItem[]>(`/hosts/${hid}/events?days=7`).catch(() => []) });
  const { data: metricsHistory } = useQuery({ queryKey: queryKeys.hostMetricsHistory(hostId), queryFn: () => api<HostMetricsSnapshot[]>(`/hosts/${hid}/metrics?hours=24`).catch(() => []), refetchInterval: 60_000 });
  const { data: allHosts } = useQuery({ queryKey: queryKeys.hosts(), queryFn: () => api<Host[]>('/hosts'), staleTime: 30_000 });
  const { data: baselines } = useQuery({
    queryKey: queryKeys.hostBaselines(hostId),
    queryFn: () => api<HostBaselinesResponse>(`/hosts/${hid}/baselines`).catch(() => ({ host_id: hostId!, metrics: [], computed_at: null }) as HostBaselinesResponse),
    refetchInterval: 5 * 60_000,
  });

  // Prev/next sibling navigation — alphabetical by host_id, matching the hosts page order.
  const hostIds = allHosts?.map(h => h.host_id) ?? [];
  const currentIdx = hostId ? hostIds.indexOf(hostId) : -1;
  const prevHost = currentIdx > 0 ? hostIds[currentIdx - 1] : null;
  const nextHost = currentIdx >= 0 && currentIdx < hostIds.length - 1 ? hostIds[currentIdx + 1] : null;
  const goToHost = (id: string) => navigate(`/hosts/${encodeURIComponent(id)}`);

  const hasInsights = (insights ?? []).length > 0;

  // Keyboard shortcuts — registered unconditionally (Rules of Hooks).
  useKeyboardShortcut({ keys: '1', description: 'Overview tab', scope: 'Host detail', onTrigger: () => handleTabChange('overview') });
  useKeyboardShortcut({ keys: '2', description: 'Resources tab', scope: 'Host detail', onTrigger: () => handleTabChange('resources') });
  useKeyboardShortcut({ keys: '3', description: 'Alerts tab', scope: 'Host detail', onTrigger: () => handleTabChange('alerts') });
  useKeyboardShortcut({ keys: '4', description: 'Insights tab', scope: 'Host detail', disabled: !hasInsights, onTrigger: () => handleTabChange('insights') });
  useKeyboardShortcut({ keys: '5', description: 'K8s Events / Proxmox tab', scope: 'Host detail', onTrigger: () => handleTabChange(data?.runtime_type === 'proxmox' ? 'pve' : 'k8s-events') });
  useKeyboardShortcut({ keys: 'b', description: 'Back to hosts', scope: 'Host detail', onTrigger: () => navigate('/hosts') });
  useKeyboardShortcut({ keys: '[', description: 'Previous host', scope: 'Host detail', disabled: !prevHost, onTrigger: () => { if (prevHost) goToHost(prevHost); } });
  useKeyboardShortcut({ keys: ']', description: 'Next host', scope: 'Host detail', disabled: !nextHost, onTrigger: () => { if (nextHost) goToHost(nextHost); } });

  if (!data) return (
    <div className="space-y-6">
      <div className="h-4 w-24 animate-pulse rounded bg-border" />
      <div className="h-7 w-48 animate-pulse rounded bg-border" />
      <StatsGridSkeleton count={5} />
      <CardSkeleton lines={5} />
    </div>
  );

  const isK8s = data.runtime_type === 'kubernetes';
  const isPve = data.runtime_type === 'proxmox';
  const tabs = [
    { id: 'overview', label: 'Overview', shortcut: '1' },
    { id: 'resources', label: 'Resources', shortcut: '2' },
    { id: 'alerts', label: 'Alerts', count: data.alerts.length, shortcut: '3' },
    ...(hasInsights
      ? [{ id: 'insights', label: 'Insights', count: (insights ?? []).length, shortcut: '4' }]
      : []
    ),
    ...(isK8s ? [{ id: 'k8s-events', label: 'Events', shortcut: '5' }] : []),
    // Distinct shortcut from k8s events since the two are mutually exclusive
    // by runtime — '5' on a PVE host opens this tab; on k8s opens Events.
    ...(isPve ? [{ id: 'pve', label: 'Proxmox', shortcut: '5' }] : []),
  ];

  return (
    <div className="animate-fade-in space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <BackLink to="/hosts" label="Back to Hosts" />
        {(prevHost || nextHost) && (
          <div className="flex items-center gap-1 text-xs">
            <button
              type="button"
              onClick={() => prevHost && goToHost(prevHost)}
              disabled={!prevHost}
              title={prevHost ? `Previous: ${prevHost} ([)` : 'No previous host'}
              className="rounded px-2 py-1 text-muted transition-colors hover:bg-bg-secondary hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted"
            >
              ← {prevHost ?? '—'}
            </button>
            <span className="px-1 text-[10px] text-muted">{currentIdx >= 0 && hostIds.length > 0 ? `${currentIdx + 1}/${hostIds.length}` : ''}</span>
            <button
              type="button"
              onClick={() => nextHost && goToHost(nextHost)}
              disabled={!nextHost}
              title={nextHost ? `Next: ${nextHost} (])` : 'No next host'}
              className="rounded px-2 py-1 text-muted transition-colors hover:bg-bg-secondary hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted"
            >
              {nextHost ?? '—'} →
            </button>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <StatusDot status={data.is_online ? 'online' : 'offline'} size="lg" />
          <h1 className="text-xl font-bold text-fg">{data.host_id}</h1>
          <Badge text={data.is_online ? 'online' : 'offline'} color={data.is_online ? 'green' : 'red'} />
          {data.runtime_type && data.runtime_type !== 'docker' && (
            <Badge
              text={data.runtime_type === 'kubernetes' ? 'k8s' : data.runtime_type}
              color={data.runtime_type === 'proxmox' ? 'purple' : 'blue'}
            />
          )}
          {data.nodeConditions && data.nodeConditions.length > 0 && (
            <NodeConditionBadges conditions={data.nodeConditions} />
          )}
          <HostGroupEditor hostId={hostId!} group={data.host_group ?? null} override={data.host_group_override ?? null} />
          {isK8s && (
            <Link
              to={`/clusters/${encodeURIComponent(data.host_group_override || data.host_group || `cluster-${hostId}`)}`}
              className="rounded border border-info/40 bg-info/5 px-2 py-0.5 text-xs font-medium text-info hover:bg-info/10"
              title="Open the cluster overview"
            >
              View cluster →
            </Link>
          )}
          {data.pveHypervisor && (
            <Link
              to={`/hosts/${encodeURIComponent(data.pveHypervisor.pveHostId)}/containers/${encodeURIComponent(data.pveHypervisor.containerName)}`}
              className="rounded border border-info/40 bg-info/5 px-2 py-0.5 text-xs font-medium text-info hover:bg-info/10"
              title="This host runs as a guest on a Proxmox hypervisor — see how the hypervisor sees it (snapshots, backups, host-side stats)."
            >
              View hypervisor view →
            </Link>
          )}
        </div>
        <RemoveHostButton hostId={hostId!} confirm={confirm} />
      </div>

      <HostUptimeHero data={data} timeline={timeline} />

      {data.proxmox && data.pveHypervisor && (
        <HypervisorInfoCard
          proxmox={data.proxmox}
          pveHostId={data.pveHypervisor.pveHostId}
          containerName={data.pveHypervisor.containerName}
        />
      )}

      <Tabs tabs={tabs} active={activeTab} onChange={handleTabChange} />

      <ActionResult result={actionResult} />

      {activeTab === 'overview' && (
        <HostOverviewTab
          data={data}
          timeline={timeline}
          hostId={hostId!}
          navigate={navigate}
          isAuthenticated={isAuthenticated}
          actionLoading={actionLoading}
          runAction={runAction}
          removeContainer={removeContainer}
          metricsHistory={metricsHistory}
        />
      )}

      {activeTab === 'resources' && (
        <HostResourcesTab data={data} trends={trends} />
      )}

      {activeTab === 'alerts' && (
        <HostAlertsTab data={data} events={events} hostId={hostId!} />
      )}

      {activeTab === 'k8s-events' && isK8s && (
        <HostK8sEventsTab hostId={hostId!} />
      )}

      {activeTab === 'pve' && isPve && (
        <HostPveTab data={data} />
      )}

      {activeTab === 'insights' && hasInsights && (
        <InsightsTabPanel insights={insights ?? []} emptyMessage="No insights for this host." />
      )}

      {(() => {
        const k8sNamespaces = isK8s
          ? Array.from(new Set(data.containers.map(c => getContainerNamespace(c.container_name)).filter((n): n is string => n != null))).sort()
          : [];
        const clusterId = isK8s ? (data.host_group_override || data.host_group || `cluster-${hostId}`) : null;
        const showDrawer = (data.anomalies?.length ?? 0) > 0
          || (baselines?.metrics?.length ?? 0) > 0
          || k8sNamespaces.length > 0;
        if (!showDrawer) return null;
        return (
          <ExploreDrawer description="Baselines, historical anomalies, and (k8s) cluster topology for this host.">
            <BaselinesViewer data={baselines} />
            {clusterId && k8sNamespaces.length > 0 && (
              <TopologyLinkCard
                clusterId={clusterId}
                namespaces={k8sNamespaces}
                description={`Namespaces with pods on this node (${k8sNamespaces.length}). Each link opens the topology graph.`}
              />
            )}
            <AnomaliesList anomalies={data.anomalies} scope="host" />
          </ExploreDrawer>
        );
      })()}

      <ConfirmDialog {...dialogProps} />
    </div>
  );
}

function HostGroupEditor({ hostId, group, override }: { hostId: string; group: string | null; override: string | null }) {
  const { isAuthenticated, token } = useAuth();
  const queryClient = useQueryClient();
  // editing === null → not editing; otherwise the current input value
  const [editing, setEditing] = useState<string | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['host', hostId] });
    queryClient.invalidateQueries({ queryKey: ['hosts'] });
  };

  const saveMutation = useMutation({
    mutationFn: (value: string) =>
      apiAuth('PUT', `/hosts/${encodeURIComponent(hostId)}/group`, { host_group: value || null }, token),
    onSuccess: () => { invalidate(); setEditing(null); },
  });

  const resetMutation = useMutation({
    mutationFn: () => apiAuth('DELETE', `/hosts/${encodeURIComponent(hostId)}/group`, undefined, token),
    onSuccess: () => { invalidate(); setEditing(null); },
  });

  // Read-only render for unauthenticated users (or when no group at all)
  if (!isAuthenticated) {
    return group ? <Badge text={group} color="gray" /> : null;
  }

  if (editing === null) {
    return (
      <button
        type="button"
        onClick={() => setEditing(override ?? group ?? '')}
        className="inline-flex items-center gap-1 cursor-pointer"
        title="Edit host group"
      >
        {group
          ? <Badge text={group} color="gray" />
          : <span className="text-xs text-muted underline decoration-dotted">set group</span>}
        {override != null && <span className="text-xs text-muted">(manual)</span>}
        <span className="text-xs text-muted">✎</span>
      </button>
    );
  }

  return (
    <div className="inline-flex items-center gap-1">
      <Input
        type="text"
        value={editing}
        autoFocus
        placeholder="group name"
        onChange={(e) => setEditing(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') saveMutation.mutate(editing.trim());
          if (e.key === 'Escape') setEditing(null);
        }}
        className="!w-32 !py-1 !text-xs"
      />
      <Button size="sm" variant="primary" onClick={() => saveMutation.mutate(editing.trim())} disabled={saveMutation.isPending}>Save</Button>
      <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
      {override != null && (
        <Button size="sm" variant="ghost" onClick={() => resetMutation.mutate()} disabled={resetMutation.isPending} title="Revert to agent value">
          Reset
        </Button>
      )}
    </div>
  );
}

function RemoveHostButton({ hostId, confirm }: { hostId: string; confirm: (opts: { title: string; message: string; confirmLabel?: string; danger?: boolean }) => Promise<boolean> }) {
  const { isAuthenticated, token } = useAuth();
  const navigate = useNavigate();

  if (!isAuthenticated) return null;

  const remove = async () => {
    const confirmed = await confirm({
      title: 'Remove Host',
      message: `Remove host "${hostId}" and all its data? This cannot be undone.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await apiAuth('DELETE', `/hosts/${encodeURIComponent(hostId)}`, undefined, token);
      navigate('/hosts');
    } catch { /* ignore */ }
  };

  return (
    <Button variant="danger" size="sm" onClick={remove}>Remove Host</Button>
  );
}
