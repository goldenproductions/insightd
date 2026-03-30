const logger = require('../utils/logger');

async function collectContainers(db, docker) {
  const containers = await docker.listContainers({ all: true });

  const insert = db.prepare(`
    INSERT INTO container_snapshots (container_name, container_id, status, restart_count, collected_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `);

  const insertMany = db.transaction((items) => {
    for (const c of items) {
      insert.run(c.name, c.id, c.status, c.restartCount);
    }
  });

  const parsed = containers.map(c => ({
    name: (c.Names[0] || '').replace(/^\//, ''),
    id: c.Id.slice(0, 12),
    status: c.State,
    restartCount: c.Labels?.['com.docker.compose.container-number'] ? 0 : 0, // will be enriched below
  }));

  // Get restart counts via inspect
  // We track both Docker's RestartCount (policy restarts) and detect manual
  // restarts by comparing StartedAt with the previous snapshot.
  const prevStartTimes = {};
  const prevRows = db.prepare(`
    SELECT container_name, MAX(collected_at) as last_collected
    FROM container_snapshots GROUP BY container_name
  `).all();
  // We'll use a separate query to get the last known restart_count per container
  const prevRestarts = {};
  for (const row of prevRows) {
    const prev = db.prepare(`
      SELECT restart_count FROM container_snapshots
      WHERE container_name = ? ORDER BY collected_at DESC LIMIT 1
    `).get(row.container_name);
    if (prev) prevRestarts[row.container_name] = prev.restart_count;
  }

  for (const p of parsed) {
    try {
      const info = await docker.getContainer(p.id).inspect();
      const dockerRestarts = info.RestartCount || 0;
      const startedAt = info.State?.StartedAt;

      // Check if container was restarted since last collection
      // by comparing Docker's RestartCount with our last stored value
      const prevCount = prevRestarts[p.name] ?? 0;
      if (dockerRestarts > prevCount) {
        // Docker-tracked restarts increased
        p.restartCount = dockerRestarts;
      } else if (startedAt && info.State?.Running) {
        // Check if StartedAt is newer than our last collection
        // This catches manual restarts that don't increment RestartCount
        const lastRow = db.prepare(`
          SELECT collected_at FROM container_snapshots
          WHERE container_name = ? AND status = 'running'
          ORDER BY collected_at DESC LIMIT 1
        `).get(p.name);

        if (lastRow) {
          const lastCollected = new Date(lastRow.collected_at + 'Z');
          const started = new Date(startedAt);
          if (started > lastCollected) {
            // Container started after our last collection — it was restarted
            p.restartCount = prevCount + 1;
          } else {
            p.restartCount = prevCount;
          }
        } else {
          p.restartCount = dockerRestarts;
        }
      } else {
        p.restartCount = prevCount;
      }
    } catch {
      // container may have been removed between list and inspect
    }
  }

  insertMany(parsed);
  logger.info('containers', `Collected ${parsed.length} containers`);
  return parsed;
}

module.exports = { collectContainers };
