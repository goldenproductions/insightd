const fs = require('fs');
const logger = require('../utils/logger');

function collectDisk(db, config) {
  const insert = db.prepare(`
    INSERT INTO disk_snapshots (mount_point, total_gb, used_gb, used_percent, collected_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `);

  // Try host-mounted filesystem first, fall back to native
  let mountsPath = `${config.hostRoot}/proc/mounts`;
  let rootPrefix = config.hostRoot;

  if (!fs.existsSync(mountsPath)) {
    mountsPath = '/proc/mounts';
    rootPrefix = '';
    logger.warn('disk', 'Host root not mounted at /host — reading container filesystem instead');
  }

  const mounts = fs.readFileSync(mountsPath, 'utf8');
  const realDevices = mounts
    .split('\n')
    .filter(line => /^\/dev\/(sd|nvme|vd|xvd|loop|mapper\/)/.test(line))
    .map(line => {
      const parts = line.split(/\s+/);
      return { device: parts[0], mountPoint: parts[1] };
    })
    // Deduplicate by mount point
    .filter((item, i, arr) => arr.findIndex(x => x.mountPoint === item.mountPoint) === i);

  const insertMany = db.transaction((items) => {
    for (const d of items) {
      insert.run(d.mountPoint, d.totalGb, d.usedGb, d.usedPercent);
    }
  });

  const results = [];
  for (const { device, mountPoint } of realDevices) {
    try {
      const statPath = rootPrefix ? `${rootPrefix}${mountPoint}` : mountPoint;
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
