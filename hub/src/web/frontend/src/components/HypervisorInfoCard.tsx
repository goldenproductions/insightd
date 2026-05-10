import { Link } from 'react-router-dom';
import { Card } from '@/components/Card';
import { GlossaryHelp } from '@/components/GlossaryHelp';
import type { HostProxmoxDetail } from '@/types/api';

interface Props {
  proxmox: HostProxmoxDetail;
  /** host_id of the PVE hypervisor that manages this guest — used to build the
   *  "View on hypervisor" link. */
  pveHostId: string;
  /** Container name as seen by the PVE host agent (e.g. "proxmox-01/108"). */
  containerName: string;
}

/**
 * Card shown on the HostDetailPage for in-guest hosts that are linked to a
 * Proxmox VE hypervisor. Surfaces the key PVE-side metadata (node, VMID,
 * type, cluster, snapshots, last backup) and links back to the PVE container
 * detail page.
 */
export function HypervisorInfoCard({ proxmox, pveHostId, containerName }: Props) {
  const lastBackup = proxmox.last_backup_at
    ? new Date(proxmox.last_backup_at).toLocaleString()
    : '—';

  return (
    <Card className="border-l-[3px] border-l-info">
      <div className="mb-3 flex items-center gap-1.5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-secondary">
          Hypervisor info
        </h2>
        <GlossaryHelp topic="hypervisor-link" />
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
        <dt className="text-muted">PVE node</dt>
        <dd className="font-mono text-fg">{proxmox.node}</dd>
        <dt className="text-muted">Type</dt>
        <dd className="text-fg">{proxmox.guest_type ?? '—'}</dd>
        <dt className="text-muted">VMID</dt>
        <dd className="font-mono text-fg">{proxmox.vmid}</dd>
        <dt className="text-muted">Cluster</dt>
        <dd className="text-fg">{proxmox.cluster_id ?? '—'}</dd>
        <dt className="text-muted">Snapshots</dt>
        <dd className="tabular-nums text-fg">{proxmox.snapshots_count}</dd>
        <dt className="text-muted">Last backup</dt>
        <dd className="text-fg">{lastBackup}</dd>
      </dl>
      <div className="mt-3 border-t border-border pt-2.5">
        <Link
          to={`/hosts/${encodeURIComponent(pveHostId)}/containers/${encodeURIComponent(containerName)}`}
          className="text-sm text-info hover:underline"
        >
          View on hypervisor →
        </Link>
      </div>
    </Card>
  );
}
