/**
 * Extracts a Proxmox guest link from host labels set by the manual-bridge
 * env vars (INSIGHTD_PROXMOX_NODE + INSIGHTD_PROXMOX_VMID) on the in-guest agent.
 *
 * The agent publishes: label `insightd.proxmox.guest` = `<node>/<vmid>`
 * e.g. `pve1/108`
 */
export function extractProxmoxLink(
  labels: Record<string, string> | null | undefined,
): { node: string; vmid: number } | null {
  if (!labels) return null;
  const v = labels['insightd.proxmox.guest'];
  if (!v) return null;
  const idx = v.indexOf('/');
  if (idx <= 0) return null;
  const node = v.slice(0, idx);
  const vmidStr = v.slice(idx + 1);
  const vmid = parseInt(vmidStr, 10);
  if (!node || !Number.isFinite(vmid) || String(vmid) !== vmidStr) return null;
  return { node, vmid };
}
