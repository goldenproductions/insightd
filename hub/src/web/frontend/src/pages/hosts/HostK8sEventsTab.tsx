import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import type { HostK8sEventsResponse } from '@/types/api';
import { Card } from '@/components/Card';
import { DataTable, type Column } from '@/components/DataTable';
import { Badge } from '@/components/Badge';
import { EmptyState } from '@/components/EmptyState';
import { CardSkeleton } from '@/components/Skeleton';
import { timeAgo } from '@/lib/formatters';
import type { K8sEvent } from '@/types/api';

// Reasons that carry enough user-actionable weight to warrant a distinct
// red badge. Everything else renders as a regular warning tag.
const SEVERE_REASONS = new Set([
  'OOMKilled', 'Evicted', 'FailedScheduling', 'FailedMount',
  'FailedCreatePodSandBox', 'CrashLoopBackOff', 'ErrImagePull',
  'ImagePullBackOff', 'InvalidDiskCapacity', 'NodeNotReady',
]);

interface Props {
  hostId: string;
}

export function HostK8sEventsTab({ hostId }: Props) {
  // Don't catch — let the error bubble so we can distinguish "request failed"
  // from "this host has no cluster". The previous `.catch(() => ({ clusterId:
  // null }))` collapsed both cases into the misleading "not a k8s host"
  // empty state, which was wrong whenever the request itself failed (auth,
  // network, server error).
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.k8sEvents(hostId),
    queryFn: () =>
      api<HostK8sEventsResponse>(`/hosts/${encodeURIComponent(hostId)}/k8s-events?limit=200`),
    refetchInterval: 30_000,
  });

  if (isLoading) return <CardSkeleton lines={6} />;

  if (error) {
    return (
      <EmptyState
        message={`Couldn't load Kubernetes events: ${(error as Error).message}`}
      />
    );
  }

  // clusterId is null only when the host genuinely isn't k8s — getClusterIdForHost
  // returns null for runtime_type !== 'kubernetes'. The events tab is normally
  // hidden for non-k8s hosts, so this branch is mostly defensive.
  if (!data?.clusterId) {
    return (
      <EmptyState message="Kubernetes events are only available for k8s hosts." />
    );
  }

  if (data.items.length === 0) {
    return (
      <div className="space-y-3">
        <div className="text-xs text-muted">
          Cluster <span className="font-mono">{data.clusterId}</span> · no Warning events in the stored window
        </div>
        <EmptyState message="No Warning events captured yet. The agent polls every collection cycle; k8s events age out after ~1h on the apiserver, so a quiet cluster shows nothing here." />
      </div>
    );
  }

  const columns: Column<K8sEvent>[] = [
    {
      header: 'When',
      accessor: r => <span title={`first: ${r.first_seen_at}\nlast: ${r.last_seen_at}`}>{timeAgo(r.last_seen_at)}</span>,
    },
    {
      header: 'Namespace',
      accessor: r => r.namespace ? <span className="font-mono text-xs">{r.namespace}</span> : <span className="text-muted">—</span>,
    },
    {
      header: 'Object',
      accessor: r => (
        <div className="flex flex-col">
          <span className="font-mono text-xs text-muted">{r.involved_kind}</span>
          <span className="font-mono text-xs">{r.involved_name}</span>
        </div>
      ),
    },
    {
      header: 'Reason',
      accessor: r => (
        <div className="flex items-center gap-2">
          <Badge text={r.reason} color={SEVERE_REASONS.has(r.reason) ? 'red' : 'yellow'} />
          {r.count > 1 && (
            <span className="text-xs text-muted" title="Times this event re-fired">×{r.count}</span>
          )}
        </div>
      ),
    },
    {
      header: 'Message',
      accessor: r => <span className="text-xs text-secondary">{r.message ?? '—'}</span>,
    },
  ];

  return (
    <div className="space-y-3">
      <div className="text-xs text-muted">
        Cluster <span className="font-mono">{data.clusterId}</span> · {data.items.length} Warning events
      </div>
      <Card title="Kubernetes Warning Events">
        <DataTable columns={columns} data={data.items} />
      </Card>
    </div>
  );
}
