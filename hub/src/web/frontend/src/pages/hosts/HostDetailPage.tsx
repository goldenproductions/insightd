import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, apiAuth } from '@/lib/api';
import type { HostDetail, TimelineEntry, Trends, EventItem, BaselineRow } from '@/types/api';
import { StatusDot } from '@/components/StatusDot';
import { Badge } from '@/components/Badge';
import { Button, Input } from '@/components/FormField';
import { Tabs } from '@/components/Tabs';
import { BackLink } from '@/components/BackLink';
import { ActionResult } from '@/components/ActionResult';
import { StatsGridSkeleton, CardSkeleton } from '@/components/Skeleton';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useShowInternal } from '@/hooks/useShowInternal';
import { useAuth } from '@/context/AuthContext';
import { useContainerAction } from '@/hooks/useContainerAction';
import { useConfirm } from '@/hooks/useConfirm';
import { useState } from 'react';
import { queryKeys } from '@/lib/queryKeys';
import { HostOverviewTab } from './HostOverviewTab';
import { HostResourcesTab } from './HostResourcesTab';
import { HostAlertsTab } from './HostAlertsTab';

export function HostDetailPage() {
  const { hostId } = useParams();
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  const { showInternal } = useShowInternal();
  const hid = encodeURIComponent(hostId!);
  const si = showInternal ? '?showInternal=true' : '';
  const [activeTab, setActiveTab] = useState('overview');
  const { confirm, dialogProps } = useConfirm();
  const { actionLoading, actionResult, runAction, removeContainer } = useContainerAction(hostId!, [['host', hostId, showInternal]], confirm);

  const { data } = useQuery({ queryKey: queryKeys.host(hostId, showInternal), queryFn: () => api<HostDetail>(`/hosts/${hid}${si}`), refetchInterval: 30_000 });
  const { data: timeline } = useQuery({ queryKey: queryKeys.timeline(hostId), queryFn: () => api<TimelineEntry[]>(`/hosts/${hid}/timeline?days=7`).catch(() => []) });
  const { data: trends } = useQuery({ queryKey: queryKeys.trends(hostId), queryFn: () => api<Trends>(`/hosts/${hid}/trends`).catch(() => ({ containers: [], host: null })) });
  const { data: events } = useQuery({ queryKey: queryKeys.events(hostId), queryFn: () => api<EventItem[]>(`/hosts/${hid}/events?days=7`).catch(() => []) });
  const { data: baselines, isFetched: baselinesReady } = useQuery({ queryKey: queryKeys.hostBaselines(hostId), queryFn: () => api<BaselineRow[]>(`/baselines/host/${hid}`).catch(() => []), refetchInterval: false });

  if (!data) return (
    <div className="space-y-6">
      <div className="h-4 w-24 animate-pulse rounded bg-border" />
      <div className="h-7 w-48 animate-pulse rounded bg-border" />
      <StatsGridSkeleton count={5} />
      <CardSkeleton lines={5} />
    </div>
  );

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'resources', label: 'Resources' },
    { id: 'alerts', label: 'Alerts', count: data.alerts.length },
  ];

  return (
    <div className="animate-fade-in space-y-6">
      <BackLink to="/hosts" label="Back to Hosts" />

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <StatusDot status={data.is_online ? 'online' : 'offline'} size="lg" />
          <h1 className="text-xl font-bold text-fg">{data.host_id}</h1>
          <Badge text={data.is_online ? 'online' : 'offline'} color={data.is_online ? 'green' : 'red'} />
          {data.runtime_type && data.runtime_type !== 'docker' && (
            <Badge text={data.runtime_type === 'kubernetes' ? 'k8s' : data.runtime_type} color="blue" />
          )}
          <HostGroupEditor hostId={hostId!} group={data.host_group ?? null} override={data.host_group_override ?? null} />
        </div>
        <RemoveHostButton hostId={hostId!} confirm={confirm} />
      </div>

      <Tabs tabs={tabs} active={activeTab} onChange={setActiveTab} />

      <ActionResult result={actionResult} />

      {activeTab === 'overview' && (
        <HostOverviewTab
          data={data}
          timeline={timeline}
          hostId={hostId!}
          hid={hid}
          navigate={navigate}
          isAuthenticated={isAuthenticated}
          actionLoading={actionLoading}
          runAction={runAction}
          removeContainer={removeContainer}
          baselines={baselinesReady ? baselines : undefined}
        />
      )}

      {activeTab === 'resources' && (
        <HostResourcesTab data={data} trends={trends} />
      )}

      {activeTab === 'alerts' && (
        <HostAlertsTab data={data} events={events} />
      )}

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
