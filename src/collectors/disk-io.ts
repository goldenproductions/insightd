import fs = require('fs');
import path = require('path');

interface DiskIOConfig {
  hostRoot?: string;
}

interface DiskStats {
  readSectors: number;
  writeSectors: number;
}

interface SampleState {
  prevStats: Record<string, DiskStats>;
  prevTime: number;
}

const sampleStateByPath: Record<string, SampleState> = Object.create(null);

function parseCounter(value: string | undefined): number | null {
  if (value == null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isTrackedDevice(device: string): boolean {
  return /^(sd[a-z]+|nvme\d+n\d+|vd[a-z]+|xvd[a-z]+|mmcblk\d+|dm-\d+|md\d+)$/.test(device);
}

function isLogicalAggregateDevice(device: string): boolean {
  return /^(dm-\d+|md\d+)$/.test(device);
}

function listExcludedSlaveDevices(hostRoot: string, devices: Iterable<string>): Set<string> {
  const excluded = new Set<string>();

  for (const device of devices) {
    if (!isLogicalAggregateDevice(device)) continue;

    try {
      const slaveDir = path.join(hostRoot, 'sys', 'block', device, 'slaves');
      for (const slave of fs.readdirSync(slaveDir)) {
        if (slave) excluded.add(slave);
      }
    } catch {
      // Missing slave metadata â€” keep raw devices rather than undercounting.
    }
  }

  return excluded;
}

function mergeStats(
  prevStats: Record<string, DiskStats>,
  currentStats: Record<string, DiskStats>,
  malformedDevices: Set<string>
): Record<string, DiskStats> {
  const merged: Record<string, DiskStats> = { ...currentStats };

  for (const device of malformedDevices) {
    if (prevStats[device]) merged[device] = prevStats[device];
  }

  return merged;
}

/**
 * Collect disk I/O from /proc/diskstats (delta-based).
 * Returns aggregated read/write bytes per second across all real devices.
 */
function collectDiskIO(config?: DiskIOConfig): { readBytesPerSec: number; writeBytesPerSec: number } | null {
  const hostRoot = config?.hostRoot || '/host';
  const diskstatsPath = path.join(hostRoot, 'proc', 'diskstats');

  try {
    const content = fs.readFileSync(diskstatsPath, 'utf8');
    const now = Date.now();
    const stats: Record<string, DiskStats> = {};
    const malformedDevices = new Set<string>();

    for (const line of content.trim().split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 14) continue;

      const device = parts[2];
      if (!isTrackedDevice(device)) continue;

      const readSectors = parseCounter(parts[5]);
      const writeSectors = parseCounter(parts[9]);
      if (readSectors == null || writeSectors == null) {
        malformedDevices.add(device);
        continue;
      }

      stats[device] = { readSectors, writeSectors };
    }

    if (Object.keys(stats).length === 0) {
      if (malformedDevices.size > 0) return null;
      delete sampleStateByPath[diskstatsPath];
      return null;
    }

    const state = sampleStateByPath[diskstatsPath];
    if (!state) {
      sampleStateByPath[diskstatsPath] = { prevStats: stats, prevTime: now };
      return null;
    }

    const mergedStats = mergeStats(state.prevStats, stats, malformedDevices);
    const elapsedSec = (now - state.prevTime) / 1000;
    if (elapsedSec < 1) {
      sampleStateByPath[diskstatsPath] = { prevStats: mergedStats, prevTime: now };
      return null;
    }

    const currentAggregateDevices = new Set<string>([
      ...Object.keys(stats).filter(isLogicalAggregateDevice),
      ...Array.from(malformedDevices).filter(isLogicalAggregateDevice),
    ]);
    const excludedSlaves = listExcludedSlaveDevices(hostRoot, currentAggregateDevices);
    let totalReadBytesPerSec = 0;
    let totalWriteBytesPerSec = 0;

    for (const [device, curr] of Object.entries(stats)) {
      if (excludedSlaves.has(device)) continue;

      const prev = state.prevStats[device];
      if (!prev) continue;

      totalReadBytesPerSec += Math.max(0, (curr.readSectors - prev.readSectors) * 512 / elapsedSec);
      totalWriteBytesPerSec += Math.max(0, (curr.writeSectors - prev.writeSectors) * 512 / elapsedSec);
    }

    sampleStateByPath[diskstatsPath] = { prevStats: mergedStats, prevTime: now };
    return {
      readBytesPerSec: Math.round(totalReadBytesPerSec),
      writeBytesPerSec: Math.round(totalWriteBytesPerSec),
    };
  } catch {
    return null;
  }
}

module.exports = { collectDiskIO };
