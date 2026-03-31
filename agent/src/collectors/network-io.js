const fs = require('fs');
const path = require('path');
const logger = require('../../../shared/utils/logger');

// Previous sample for delta calculation
let prevStats = null;
let prevTime = null;

// Interfaces to skip (virtual/container)
const SKIP_PREFIXES = ['lo', 'docker', 'br-', 'veth', 'cali', 'flannel', 'cni', 'tunl', 'wg'];

/**
 * Collect host-level network I/O from /proc/net/dev (delta-based).
 * Returns aggregated rx/tx bytes per second across physical interfaces.
 */
function collectNetworkIO(config) {
  const hostRoot = config?.hostRoot || '/host';
  const netDevPath = path.join(hostRoot, 'proc/net/dev');

  try {
    const content = fs.readFileSync(netDevPath, 'utf8');
    const now = Date.now();
    const stats = {};

    const lines = content.trim().split('\n').slice(2); // Skip header lines
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const iface = (parts[0] || '').replace(':', '');
      if (!iface || SKIP_PREFIXES.some(p => iface.startsWith(p))) continue;

      stats[iface] = {
        rxBytes: parseInt(parts[1], 10) || 0,
        txBytes: parseInt(parts[9], 10) || 0,
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

    let totalRxBytesPerSec = 0;
    let totalTxBytesPerSec = 0;

    for (const [iface, curr] of Object.entries(stats)) {
      const prev = prevStats[iface];
      if (!prev) continue;
      totalRxBytesPerSec += Math.max(0, (curr.rxBytes - prev.rxBytes) / elapsedSec);
      totalTxBytesPerSec += Math.max(0, (curr.txBytes - prev.txBytes) / elapsedSec);
    }

    prevStats = stats;
    prevTime = now;

    return {
      rxBytesPerSec: Math.round(totalRxBytesPerSec),
      txBytesPerSec: Math.round(totalTxBytesPerSec),
    };
  } catch {
    return null;
  }
}

module.exports = { collectNetworkIO };
