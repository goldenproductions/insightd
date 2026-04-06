import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, apiAuth } from '@/lib/api';
import type { HostDetail, TimelineEntry, Trends, EventItem } from '@/types/api';
import { StatusDot } from '@/components/StatusDot';
import { Badge } from '@/components/Badge';
import { Tabs } from '@/components/Tabs';
import { BackLink } from '@/components/BackLink';
import { ActionResult } from '@/components/ActionResult';
import { LoadingState } from '@/components/LoadingState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useShowInternal } from '@/hooks/useShowInternal';
import { useAuth } from '@/context/AuthContext';
import { useContainerAction } from '@/hooks/useContainerAction';
import { useConfirm } from '@/hooks/useConfirm';
import { useTab } from '@/hooks/useTab';
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
  const { activeTab, setActiveTab } = useTab('overview');
  const { confirm, dialogProps } = useConfirm();
  const { actionLoading, actionResult, runAction } = useContainerAction(hostId!, [['host', hostId, showInternal]], confirm);

  const { data } = useQuery({ queryKey: ['host', hostId, showInternal], queryFn: () => api<HostDetail>(`/hosts/${hid}${si}`), refetchInterval: 30_000 });
  const { data: timeline } = useQuery({ queryKey: ['timeline', hostId], queryFn: () => api<TimelineEntry[]>(`/hosts/${hid}/timeline?days=7`).catch(() => []) });
  const { data: trends } = useQuery({ queryKey: ['trends', hostId], queryFn: () => api<Trends>(`/hosts/${hid}/trends`).catch(() => ({ containers: [], host: null })) });
  const { data: events } = useQuery({ queryKey: ['events', hostId], queryFn: () => api<EventItem[]>(`/hosts/${hid}/events?days=7`).catch(() => []) });

  if (!data) return <LoadingState />;

  const alertCount = data.alerts.length + (events?.length ?? 0);

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'resources', label: 'Resources' },
    { id: 'alerts', label: 'Alerts', count: alertCount },
  ];

  return (
    <div className="space-y-6">
      <BackLink to="/hosts" label="Back to Hosts" />

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <StatusDot status={data.is_online ? 'online' : 'offline'} size="lg" />
          <h1 className="text-xl font-bold text-fg">{data.host_id}</h1>
          <Badge text={data.is_online ? 'online' : 'offline'} color={data.is_online ? 'green' : 'red'} />
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
    <button onClick={remove} className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700">
      Remove Host
    </button>
  );
}
