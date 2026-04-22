import { parseQuantity } from '../runtime/kubernetes';
import type { K8sClient, K8sPv, K8sPvc } from '../runtime/kubernetes';

export interface PvInfo {
  name: string;
  phase: string;
  capacityBytes: number | null;
  accessModes: string[];
  reclaimPolicy: string | null;
  storageClass: string | null;
  volumeMode: string | null;
  claimRef: { namespace: string; name: string } | null;
  csiDriver: string | null;
  createdAt: string | null;
  labels: Record<string, string>;
}

export interface PvcInfo {
  namespace: string;
  name: string;
  phase: string;
  storageClass: string | null;
  requestBytes: number | null;
  capacityBytes: number | null;
  accessModes: string[];
  volumeName: string | null;
  volumeMode: string | null;
  createdAt: string | null;
  labels: Record<string, string>;
}

export function mapPv(pv: K8sPv): PvInfo | null {
  const name = pv.metadata?.name;
  if (!name) return null;
  const claim = pv.spec?.claimRef;
  return {
    name,
    phase: pv.status?.phase ?? 'Unknown',
    capacityBytes: parseQuantity(pv.spec?.capacity?.storage),
    accessModes: pv.spec?.accessModes ?? [],
    reclaimPolicy: pv.spec?.persistentVolumeReclaimPolicy ?? null,
    storageClass: pv.spec?.storageClassName ?? null,
    volumeMode: pv.spec?.volumeMode ?? null,
    claimRef: claim?.namespace && claim?.name ? { namespace: claim.namespace, name: claim.name } : null,
    csiDriver: pv.spec?.csi?.driver ?? null,
    createdAt: pv.metadata?.creationTimestamp ?? null,
    labels: pv.metadata?.labels ?? {},
  };
}

export function mapPvc(pvc: K8sPvc): PvcInfo | null {
  const name = pvc.metadata?.name;
  const namespace = pvc.metadata?.namespace;
  if (!name || !namespace) return null;
  return {
    namespace,
    name,
    phase: pvc.status?.phase ?? 'Unknown',
    storageClass: pvc.spec?.storageClassName ?? null,
    requestBytes: parseQuantity(pvc.spec?.resources?.requests?.storage),
    capacityBytes: parseQuantity(pvc.status?.capacity?.storage),
    accessModes: pvc.spec?.accessModes ?? [],
    volumeName: pvc.spec?.volumeName ?? null,
    volumeMode: pvc.spec?.volumeMode ?? null,
    createdAt: pvc.metadata?.creationTimestamp ?? null,
    labels: pvc.metadata?.labels ?? {},
  };
}

export async function collectPvs(client: K8sClient): Promise<PvInfo[]> {
  const list = await client.listPvs();
  return (list.items || []).map(mapPv).filter((x): x is PvInfo => x !== null);
}

export async function collectPvcs(client: K8sClient): Promise<PvcInfo[]> {
  const list = await client.listPvcs();
  return (list.items || []).map(mapPvc).filter((x): x is PvcInfo => x !== null);
}
