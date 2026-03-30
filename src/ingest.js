const logger = require('./utils/logger');

/**
 * Ingest collected container data into the database.
 */
function ingestContainers(db, hostId, containers) {
  const insert = db.prepare(`
    INSERT INTO container_snapshots (host_id, container_name, container_id, status, cpu_percent, memory_mb, restart_count, collected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const insertMany = db.transaction((items) => {
    for (const c of items) {
      insert.run(hostId, c.name, c.id, c.status, c.cpuPercent ?? null, c.memoryMb ?? null, c.restartCount);
    }
  });

  insertMany(containers);
  logger.info('ingest', `Stored ${containers.length} container snapshots for ${hostId}`);
}

/**
 * Ingest collected disk data into the database.
 */
function ingestDisk(db, hostId, diskResults) {
  const insert = db.prepare(`
    INSERT INTO disk_snapshots (host_id, mount_point, total_gb, used_gb, used_percent, collected_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);

  const insertMany = db.transaction((items) => {
    for (const d of items) {
      insert.run(hostId, d.mountPoint, d.totalGb, d.usedGb, d.usedPercent);
    }
  });

  if (diskResults.length > 0) {
    insertMany(diskResults);
  }
}

/**
 * Ingest update check results into the database.
 */
function ingestUpdates(db, hostId, updates) {
  const insert = db.prepare(`
    INSERT INTO update_checks (host_id, container_name, image, local_digest, remote_digest, has_update, checked_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const insertMany = db.transaction((items) => {
    for (const u of items) {
      insert.run(hostId, u.containerName, u.image, u.localDigest, u.remoteDigest, u.hasUpdate ? 1 : 0);
    }
  });

  if (updates.length > 0) {
    insertMany(updates);
  }
}

/**
 * Update or insert host record.
 */
function upsertHost(db, hostId) {
  db.prepare(`
    INSERT INTO hosts (host_id, first_seen, last_seen)
    VALUES (?, datetime('now'), datetime('now'))
    ON CONFLICT(host_id) DO UPDATE SET last_seen = datetime('now')
  `).run(hostId);
}

module.exports = { ingestContainers, ingestDisk, ingestUpdates, upsertHost };
