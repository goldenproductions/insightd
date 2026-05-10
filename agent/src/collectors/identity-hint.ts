/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs') as typeof import('fs');
const os = require('os') as typeof import('os');

export type IdentityHint = {
  virt_type: 'qemu' | 'lxc' | 'bare';
  system_uuid: string | null;
  hostname: string;
  primary_mac: string | null;
};

function safeRead(path: string): string | null {
  try { return fs.readFileSync(path, 'utf8'); } catch { return null; }
}

/** When agent runs in Docker on a guest VM with `/:/host:ro` mounted (and
 *  INSIGHTD_HOST_ROOT=/host), prefix paths to read the GUEST host's files
 *  rather than the docker container's. Same convention as disk collector. */
function hostPath(hostRoot: string | null, p: string): string {
  if (!hostRoot) return p;
  return `${hostRoot}${p}`;
}

function detectVirtType(hostRoot: string | null): IdentityHint['virt_type'] {
  const sysVendor = safeRead(hostPath(hostRoot, '/sys/class/dmi/id/sys_vendor'))
                 ?? safeRead('/sys/class/dmi/id/sys_vendor');
  if (sysVendor && sysVendor.trim() === 'QEMU') return 'qemu';

  const env = safeRead(hostPath(hostRoot, '/proc/1/environ'));
  if (env && env.includes('container=lxc')) return 'lxc';

  const cgroup = safeRead(hostPath(hostRoot, '/proc/self/cgroup'))
              ?? safeRead('/proc/self/cgroup');
  if (cgroup && /lxc\.payload\.\d+/.test(cgroup)) return 'lxc';

  // Docker-on-LXC fallback: when the agent runs in Docker inside an unprivileged
  // PVE LXC, `/host/proc/1/environ` is unreadable due to user-namespace mapping
  // (the agent's "root" doesn't match the host LXC's "root"), and DMI shows the
  // bare-metal hypervisor (e.g. "FUJITSU"), not QEMU. But `/host/etc/hostname`
  // IS world-readable and reflects the LXC's hostname. If that file exists,
  // is readable, and differs from the container's hostname, we're in an LXC.
  if (hostRoot) {
    const hostHostname = safeRead(hostPath(hostRoot, '/etc/hostname'))?.trim();
    if (hostHostname && hostHostname !== os.hostname()) return 'lxc';
  }

  return 'bare';
}

function readQemuUuid(hostRoot: string | null): string | null {
  const raw = safeRead(hostPath(hostRoot, '/sys/class/dmi/id/product_uuid'))
           ?? safeRead('/sys/class/dmi/id/product_uuid');
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  return /^[0-9a-f-]{36}$/.test(trimmed) ? trimmed : null;
}

function readHostHostname(hostRoot: string | null): string {
  if (hostRoot) {
    const raw = safeRead(hostPath(hostRoot, '/etc/hostname'));
    if (raw && raw.trim()) return raw.trim();
  }
  return os.hostname();
}

function pickPrimaryMac(hostRoot: string | null): string | null {
  // Prefer host's network interfaces when available — agent's own
  // `os.networkInterfaces()` shows the docker container's interfaces, not the
  // host LXC's eth0. `/host/sys/class/net/<iface>/address` is world-readable
  // and gives the actual host MAC.
  if (hostRoot) {
    try {
      const ifaceDir = hostPath(hostRoot, '/sys/class/net');
      const ifaces = fs.readdirSync(ifaceDir);
      for (const name of ifaces) {
        if (name === 'lo' || name === 'bonding_masters') continue;
        if (/^(docker|br-|veth|virbr|cni|flannel|cali)/.test(name)) continue;
        const mac = safeRead(`${ifaceDir}/${name}/address`)?.trim().toLowerCase();
        if (mac && mac !== '00:00:00:00:00:00') return mac;
      }
    } catch { /* fall through */ }
  }

  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    for (const a of addrs) {
      if (a.internal) continue;
      if (!a.mac || a.mac === '00:00:00:00:00:00') continue;
      if (/^(docker|br-|veth|virbr|cni|flannel|cali)/.test(name)) continue;
      return a.mac.toLowerCase();
    }
  }
  return null;
}

/** Resolve effective hostRoot: explicit env var, or default `/host` if that
 *  directory exists (i.e. the docker-compose `/:/host:ro` bind is present).
 *  Returns null on bare-metal/container deploys without the bind. */
function resolveHostRoot(): string | null {
  const explicit = process.env.INSIGHTD_HOST_ROOT?.trim();
  if (explicit) return explicit;
  try { if (fs.statSync('/host').isDirectory()) return '/host'; } catch { /* no /host */ }
  return null;
}

export function collectIdentityHint(): IdentityHint {
  const hostRoot = resolveHostRoot();
  const virt_type = detectVirtType(hostRoot);
  return {
    virt_type,
    system_uuid: virt_type === 'qemu' ? readQemuUuid(hostRoot) : null,
    hostname: readHostHostname(hostRoot),
    primary_mac: pickPrimaryMac(hostRoot),
  };
}
