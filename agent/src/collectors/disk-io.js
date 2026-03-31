const fs = require('fs');
const path = require('path');
const logger = require('../../../shared/utils/logger');

// Previous sample for delta calculation
let prevStats = null;
let prevTime = null;

/**
 * Collect disk I/O from /proc/diskstats (delta-based).
 * Returns aggregated read/write bytes per second across all real devices.
 */
function collectDiskIO(config) {
  const hostRoot = config?.hostRoot || '/host';
  const diskstatsPath = path.join(hostRoot, 'proc/diskstats');

  try {
    const content = fs.readFileSync(diskstatsPath, 'utf8');
    const now = Date.now();
    const stats = {};

    for (const line of content.trim().split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 14) continue;
      const device = parts[2];

      // Only real devices (skip partitions like sda1, nvme0n1p1)
      if (!device.match(/^(sd[a-z]+|nvme\d+n\d+|vd[a-z]+|xvd[a-z]+)$/)) continue;

      stats[device] = {
        readSectors: parseInt(parts[5], 10) || 0,   // sectors read
        writeSectors: parseInt(parts[9], 10) || 0,   // sectors written
      };
    }

    if (Object.keys(stats).length === 0) {
      prevStats = null;
      prevTime = null;
      return null;
    }

    if (!prevStats || !prevTime) {
      prevStats = stats;
      prevTime = now;
      return null; // First sample — gathering baseline
    }

    const elapsedSec = (now - prevTime) / 1000;
    if (elapsedSec < 1) {
      prevStats = stats;
      prevTime = now;
      return null;
    }

    let totalReadBytesPerSec = 0;
    let totalWriteBytesPerSec = 0;

    for (const [device, curr] of Object.entries(stats)) {
      const prev = prevStats[device];
      if (!prev) continue;
      // Sector size = 512 bytes
      totalReadBytesPerSec += Math.max(0, (curr.readSectors - prev.readSectors) * 512 / elapsedSec);
      totalWriteBytesPerSec += Math.max(0, (curr.writeSectors - prev.writeSectors) * 512 / elapsedSec);
    }

    prevStats = stats;
    prevTime = now;

    return {
      readBytesPerSec: Math.round(totalReadBytesPerSec),
      writeBytesPerSec: Math.round(totalWriteBytesPerSec),
    };
  } catch {
    return null;
  }
}

module.exports = { collectDiskIO };
