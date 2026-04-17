import fs = require('fs');
import path = require('path');
import logger = require('../utils/logger');

interface DiskConfig {
  hostRoot: string;
  diskWarnPercent?: number;
}

interface DiskResult {
  mountPoint: string;
  totalGb: number;
  usedGb: number;
  usedPercent: number;
}

function decodeMountField(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

function isBlockDeviceSource(source: string): boolean {
  return /^\/dev\/(?:mapper\/\S+|dm-\d+|sd[a-z]+\d*|nvme\d+n\d+(?:p\d+)?|vd[a-z]+\d*|xvd[a-z]+\d*|md\d+|mmcblk\d+(?:p\d+)?|root)$/.test(source);
}

function getStatPath(hostRoot: string, mountPoint: string): string {
  if (mountPoint === '/') return hostRoot;
  return path.join(hostRoot, mountPoint.replace(/^\/+/, ''));
}

function readMountTargets(mountsPath: string, hostRoot?: string): Array<{ mountPoint: string; statPath: string }> {
  const mounts = fs.readFileSync(mountsPath, 'utf8');
  const seen = new Set<string>();
  const mountsToCheck: Array<{ mountPoint: string; statPath: string }> = [];

  for (const line of mounts.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;

    const source = decodeMountField(parts[0]);
    if (!isBlockDeviceSource(source)) continue;

    const mountPoint = decodeMountField(parts[1]);
    if (seen.has(mountPoint)) continue;
    seen.add(mountPoint);

    mountsToCheck.push({
      mountPoint,
      statPath: hostRoot ? getStatPath(hostRoot, mountPoint) : mountPoint,
    });
  }

  return mountsToCheck;
}

/**
 * Collect disk usage stats.
 * Returns plain data array â€” no DB writes.
 */
function collectDisk(config: DiskConfig): DiskResult[] {
  const hostRoot = config.hostRoot;

  let useHostMount = false;
  try {
    useHostMount = fs.existsSync(hostRoot) && fs.statSync(hostRoot).isDirectory();
  } catch {
    useHostMount = false;
  }

  let mountsToCheck: Array<{ mountPoint: string; statPath: string }> = [];
  try {
    mountsToCheck = useHostMount
      ? readMountTargets(path.join(hostRoot, 'proc', 'mounts'), hostRoot)
      : readMountTargets('/proc/mounts');
  } catch (err) {
    if (!useHostMount) {
      logger.warn('disk', `Failed to read /proc/mounts: ${(err as Error).message}`);
      return [];
    }

    logger.warn('disk', `Failed to read host mounts from ${path.join(hostRoot, 'proc', 'mounts')}: ${(err as Error).message}`);
    return [];
  }

  if (!useHostMount) {
    logger.warn('disk', 'Host root not mounted â€” reading container filesystem instead');
  }

  const results: DiskResult[] = [];
  for (const { mountPoint, statPath } of mountsToCheck) {
    try {
      const stat = fs.statfsSync(statPath);
      const blockSize = stat.bsize;
      const totalGb = Math.round((stat.blocks * blockSize) / 1e9 * 100) / 100;
      const freeGb = Math.round((stat.bavail * blockSize) / 1e9 * 100) / 100;
      const usedGb = Math.round((totalGb - freeGb) * 100) / 100;
      const usedPercent = totalGb > 0 ? Math.round((usedGb / totalGb) * 100 * 10) / 10 : 0;

      results.push({ mountPoint, totalGb, usedGb, usedPercent });

      const warn = usedPercent >= (config.diskWarnPercent ?? 85) ? ' ⚠️' : '';
      logger.info('disk', `${mountPoint}: ${usedGb}/${totalGb}GB (${usedPercent}%)${warn}`);
    } catch (err) {
      logger.warn('disk', `Failed to stat ${mountPoint}: ${(err as Error).message}`);
    }
  }

  return results;
}

module.exports = { collectDisk };
