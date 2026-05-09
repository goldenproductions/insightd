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

function detectVirtType(): IdentityHint['virt_type'] {
  const sysVendor = safeRead('/sys/class/dmi/id/sys_vendor');
  if (sysVendor && sysVendor.trim() === 'QEMU') return 'qemu';

  const env = safeRead('/proc/1/environ');
  if (env && env.includes('container=lxc')) return 'lxc';

  const cgroup = safeRead('/proc/self/cgroup');
  if (cgroup && /lxc\.payload\.\d+/.test(cgroup)) return 'lxc';

  return 'bare';
}

function readQemuUuid(): string | null {
  const raw = safeRead('/sys/class/dmi/id/product_uuid');
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  return /^[0-9a-f-]{36}$/.test(trimmed) ? trimmed : null;
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
  const virt_type = detectVirtType();
  return {
    virt_type,
    system_uuid: virt_type === 'qemu' ? readQemuUuid() : null,
    hostname: os.hostname(),
    primary_mac: pickPrimaryMac(),
  };
}
