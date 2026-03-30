const fs = require('fs');
const logger = require('../utils/logger');

/**
 * Collect disk usage stats.
 * Returns plain data array — no DB writes.
 */
function collectDisk(config) {
  const hostRoot = config.hostRoot;
  const useHostMount = fs.existsSync(hostRoot) && fs.statSync(hostRoot).isDirectory();

  const mountsToCheck = [];

  if (useHostMount) {
    mountsToCheck.push({ mountPoint: '/', statPath: hostRoot });

    try {
      const hostStat = fs.statfsSync(hostRoot);
      const hostFsId = `${hostStat.type}:${hostStat.blocks}`;

      for (const dir of ['home', 'mnt', 'opt', 'var', 'srv']) {
        const fullPath = `${hostRoot}/${dir}`;
        try {
          if (!fs.statSync(fullPath).isDirectory()) continue;
          const dirStat = fs.statfsSync(fullPath);
          const dirFsId = `${dirStat.type}:${dirStat.blocks}`;
          if (dirFsId !== hostFsId) {
            mountsToCheck.push({ mountPoint: `/${dir}`, statPath: fullPath });
          }
        } catch { /* dir doesn't exist or can't stat */ }
      }
    } catch { /* can't stat host root */ }
  } else {
    logger.warn('disk', 'Host root not mounted — reading container filesystem instead');
    const mounts = fs.readFileSync('/proc/mounts', 'utf8');
    const seen = new Set();

    for (const line of mounts.split('\n')) {
      if (!/^\/dev\/(sd|nvme|vd|xvd|loop|mapper\/)/.test(line)) continue;
      const parts = line.split(/\s+/);
      const mountPoint = parts[1];
      if (seen.has(mountPoint)) continue;
      seen.add(mountPoint);
      mountsToCheck.push({ mountPoint, statPath: mountPoint });
    }
  }

  const results = [];
  for (const { mountPoint, statPath } of mountsToCheck) {
    try {
      const stat = fs.statfsSync(statPath);
      const blockSize = stat.bsize;
      const totalGb = Math.round((stat.blocks * blockSize) / 1e9 * 100) / 100;
      const freeGb = Math.round((stat.bavail * blockSize) / 1e9 * 100) / 100;
      const usedGb = Math.round((totalGb - freeGb) * 100) / 100;
      const usedPercent = totalGb > 0 ? Math.round((usedGb / totalGb) * 100 * 10) / 10 : 0;

      results.push({ mountPoint, totalGb, usedGb, usedPercent });

      const warn = usedPercent >= (config.diskWarnPercent || 85) ? ' ⚠️' : '';
      logger.info('disk', `${mountPoint}: ${usedGb}/${totalGb}GB (${usedPercent}%)${warn}`);
    } catch (err) {
      logger.warn('disk', `Failed to stat ${mountPoint}: ${err.message}`);
    }
  }

  return results;
}

module.exports = { collectDisk };
