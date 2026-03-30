const fs = require('fs');
const logger = require('../utils/logger');

function collectDisk(db, config) {
  const insert = db.prepare(`
    INSERT INTO disk_snapshots (mount_point, total_gb, used_gb, used_percent, collected_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `);

  const hostRoot = config.hostRoot;
  const useHostMount = fs.existsSync(hostRoot) && fs.statSync(hostRoot).isDirectory();

  // When running in a container with -v /:/host:ro, /host/proc/mounts shows
  // the container's mount namespace (not the host's). So instead of parsing
  // mounts, we stat the host root directly and any additional mount points
  // found via the container's own /proc/mounts.
  const mountsToCheck = [];

  if (useHostMount) {
    // Always stat the host root — this gives us the main filesystem
    mountsToCheck.push({ mountPoint: '/', statPath: hostRoot });

    // Also check for additional host mounts (e.g., /home, /mnt/data)
    // by looking for directories under /host that are separate filesystems
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
    // Fallback: read container's own /proc/mounts
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

  const insertMany = db.transaction((items) => {
    for (const d of items) {
      insert.run(d.mountPoint, d.totalGb, d.usedGb, d.usedPercent);
    }
  });

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

      const warn = usedPercent >= config.diskWarnPercent ? ' ⚠️' : '';
      logger.info('disk', `${mountPoint}: ${usedGb}/${totalGb}GB (${usedPercent}%)${warn}`);
    } catch (err) {
      logger.warn('disk', `Failed to stat ${mountPoint}: ${err.message}`);
    }
  }

  if (results.length > 0) {
    insertMany(results);
  }

  return results;
}

module.exports = { collectDisk };
