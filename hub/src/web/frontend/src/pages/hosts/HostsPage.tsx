import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import type { Host, ContainerSnapshot } from '@/types/api';
import { StatusDot } from '@/components/StatusDot';
import { Badge } from '@/components/Badge';
import { timeAgo } from '@/lib/formatters';
import { useShowInternal } from '@/hooks/useShowInternal';
import { PageTitle } from '@/components/PageTitle';
import { LoadingState } from '@/components/LoadingState';
import { EmptyState } from '@/components/EmptyState';
import { queryKeys } from '@/lib/queryKeys';

export function HostsPage() {
  const navigate = useNavigate();
  const { showInternal } = useShowInternal();
  const { data: hosts } = useQuery({ queryKey: queryKeys.hosts(), queryFn: () => api<Host[]>('/hosts'), refetchInterval: 30_000 });

  if (!hosts) return <LoadingState />;

  return (
    <div className="space-y-6">
      <PageTitle>Hosts</PageTitle>
      {hosts.length === 0 ? (
        <EmptyState message="No hosts connected yet" />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {hosts.map(h => (
            <HostCard key={h.host_id} host={h} showInternal={showInternal} onClick={() => navigate(`/hosts/${encodeURIComponent(h.host_id)}`)} />
          ))}
        </div>
      )}
    </div>
  );
}

function HostCard({ host, onClick, showInternal }: { host: Host; onClick: () => void; showInternal: boolean }) {
  const si = showInternal ? '?showInternal=true' : '';
  const { data: containers } = useQuery({
    queryKey: queryKeys.hostContainers(host.host_id, showInternal),
    queryFn: () => api<ContainerSnapshot[]>(`/hosts/${encodeURIComponent(host.host_id)}/containers${si}`),
    refetchInterval: 30_000,
  });

  const running = containers?.filter(c => c.status === 'running').length ?? 0;
  const total = containers?.length ?? 0;

  return (
    <div
      onClick={onClick}
      className="cursor-pointer rounded-xl p-4 hover-surface bg-surface border border-border"
    >
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 font-semibold text-fg">
          <StatusDot status={host.is_online ? 'online' : 'offline'} size="md" />
          {host.host_id}
        </span>
        <Badge text={host.is_online ? 'online' : 'offline'} color={host.is_online ? 'green' : 'red'} />
      </div>
      <div className="mt-2 text-xs text-muted">
        {running}/{total} containers running<br />
        Last seen {timeAgo(host.last_seen)}
      </div>
    </div>
  );
}

