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
  for (const p of parsed) {
    try {
      const info = await docker.getContainer(p.id).inspect();
      p.restartCount = info.RestartCount || 0;
    } catch {
      // container may have been removed between list and inspect
    }
  }

  insertMany(parsed);
  logger.info('containers', `Collected ${parsed.length} containers`);
  return parsed;
}

module.exports = { collectContainers };
