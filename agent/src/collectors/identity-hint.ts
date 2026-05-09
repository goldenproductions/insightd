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
  // DMI is exposed natively to docker containers (sysfs), so reads the same
  // value whether or not we use hostRoot. Try hostRoot first for symmetry.
  const sysVendor = safeRead(hostPath(hostRoot, '/sys/class/dmi/id/sys_vendor'))
                 ?? safeRead('/sys/class/dmi/id/sys_vendor');
  if (sysVendor && sysVendor.trim() === 'QEMU') return 'qemu';

  // /proc/1/environ MUST come from the host when in docker — the container's
  // own PID 1 environ is the agent process, not the host LXC's init.
  const env = safeRead(hostPath(hostRoot, '/proc/1/environ'));
  if (env && env.includes('container=lxc')) return 'lxc';

  const cgroup = safeRead(hostPath(hostRoot, '/proc/self/cgroup'))
              ?? safeRead('/proc/self/cgroup');
  if (cgroup && /lxc\.payload\.\d+/.test(cgroup)) return 'lxc';

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

function pickPrimaryMac(): string | null {
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

export function collectIdentityHint(): IdentityHint {
  const hostRoot = process.env.INSIGHTD_HOST_ROOT?.trim() || null;
  const virt_type = detectVirtType(hostRoot);
  return {
    virt_type,
    system_uuid: virt_type === 'qemu' ? readQemuUuid(hostRoot) : null,
    hostname: readHostHostname(hostRoot),
    primary_mac: pickPrimaryMac(),
  };
}
