import type { HostDetail } from '@/types/api';
import { Card } from '@/components/Card';
import { Badge } from '@/components/Badge';
import { EmptyState } from '@/components/EmptyState';
import { fmtBytes, timeAgo } from '@/lib/formatters';

interface Props {
  data: HostDetail;
}

/**
 * Host detail tab for Proxmox VE hypervisor signals: ZFS pool health,
 * storage pool usage, cluster quorum. Only rendered when runtime_type
 * === 'proxmox'. Each card stays calm-by-default — empty state instead of
 * a fake "all good" header — so the tab feels weightless when nothing is
 * wrong.
 */
export function HostPveTab({ data }: Props) {
  const zfs = data.pveZfsPools ?? [];
  const storage = data.pveStoragePools ?? [];
  const cluster = data.pveClusterStatus ?? null;

  if (zfs.length === 0 && storage.length === 0 && !cluster) {
    return <EmptyState message="No Proxmox VE data reported yet. Wait one collection cycle (~5 min) after the agent reboots." />;
  }

  return (
    <div className="space-y-4">
      {cluster && <ClusterCard cluster={cluster} />}
      {zfs.length > 0 && <ZfsCard pools={zfs} />}
      {storage.length > 0 && <StorageCard pools={storage} />}
    </div>
  );
}

function ClusterCard({ cluster }: { cluster: NonNullable<HostDetail['pveClusterStatus']> }) {
  const isQuorate = cluster.quorate === 1;
  return (
    <Card title="Proxmox cluster">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <div className="flex items-center gap-2">
          <span className="text-muted">{cluster.cluster_name}</span>
          <Badge text={isQuorate ? 'quorate' : 'no quorum'} color={isQuorate ? 'green' : 'red'} />
        </div>
        <div className="text-muted">
          Nodes online <span className="font-mono text-fg">{cluster.online_nodes}/{cluster.total_nodes}</span>
        </div>
        <div className="text-[11px] text-muted">observed {timeAgo(cluster.observed_at)}</div>
      </div>
    </Card>
  );
}

function zfsBadgeColor(health: string): string {
  switch (health) {
    case 'ONLINE':   return 'green';
    case 'DEGRADED': return 'yellow';
    case 'OFFLINE':  return 'gray';
    case 'FAULTED':
    case 'UNAVAIL':  return 'red';
    default:         return 'gray';
  }
}

function ZfsCard({ pools }: { pools: NonNullable<HostDetail['pveZfsPools']> }) {
  return (
    <Card title="ZFS pools">
      <div className="space-y-2">
        {pools.map(p => {
          const usedPct = p.size_bytes && p.size_bytes > 0 && p.alloc_bytes != null
            ? Math.round((p.alloc_bytes / p.size_bytes) * 100)
            : null;
          return (
            <div key={p.pool_name} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md bg-bg-secondary px-3 py-2 text-xs">
              <span className="font-mono text-sm font-medium text-fg">{p.pool_name}</span>
              <Badge text={p.health} color={zfsBadgeColor(p.health)} />
              {usedPct != null && (
                <span className="text-muted">
                  Used <span className="font-mono text-fg">{fmtBytes(p.alloc_bytes)} / {fmtBytes(p.size_bytes)}</span>
                  <span className="ml-1">({usedPct}%)</span>
                </span>
              )}
              {p.fragmentation != null && (
                <span className="text-muted">Frag <span className="font-mono text-fg">{p.fragmentation}%</span></span>
              )}
              {p.dedup_ratio != null && p.dedup_ratio > 1 && (
                <span className="text-muted">Dedup <span className="font-mono text-fg">{p.dedup_ratio.toFixed(2)}x</span></span>
              )}
              <span className="ml-auto text-[10px] text-muted">observed {timeAgo(p.observed_at)}</span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function StorageCard({ pools }: { pools: NonNullable<HostDetail['pveStoragePools']> }) {
  return (
    <Card title="Storage pools">
      <div className="space-y-2">
        {pools.map(p => {
          const inactive = p.active === 0;
          const pct = p.used_percent ?? null;
          const barCls = pct == null ? 'bg-border'
            : pct >= 95 ? 'bg-danger'
            : pct >= 85 ? 'bg-warning'
            : 'bg-success';
          return (
            <div key={p.storage_name} className="rounded-md bg-bg-secondary px-3 py-2 text-xs">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-mono text-sm font-medium text-fg">{p.storage_name}</span>
                <span className="text-[10px] uppercase tracking-wide text-muted">{p.storage_type}</span>
                {p.shared === 1 && <Badge text="shared" color="blue" />}
                {inactive && <Badge text="inactive" color="gray" />}
                {pct != null && (
                  <span className="ml-auto font-mono text-fg">
                    {fmtBytes(p.used_bytes)} / {fmtBytes(p.total_bytes)} ({pct}%)
                  </span>
                )}
              </div>
              {pct != null && (
                <div className="mt-1.5 h-1 w-full rounded bg-border/50">
                  <div className={`h-full rounded ${barCls}`} style={{ width: `${Math.min(100, pct)}%` }} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
