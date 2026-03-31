const logger = require('../../shared/utils/logger');
const { config } = require('./config');

/**
 * Perform a container update: pull new image, recreate with same config.
 * For self-updates (target=agent): the old container is left stopped —
 * cleanup happens on next agent startup via cleanupOldContainers().
 */
async function performUpdate(docker, target, image) {
  if (!config.allowUpdates) {
    throw new Error('Updates not enabled (set INSIGHTD_ALLOW_UPDATES=true)');
  }

  if (!image.startsWith('andreas404/insightd-')) {
    throw new Error(`Invalid image: ${image}. Only andreas404/insightd-* images allowed.`);
  }

  let containerId;
  if (target === 'agent') {
    containerId = process.env.HOSTNAME;
    if (!containerId) throw new Error('Cannot determine own container ID (HOSTNAME not set)');
  } else if (target === 'hub') {
    const containers = await docker.listContainers({ all: true });
    const hubContainer = containers.find(c => c.Image && c.Image.includes('insightd-hub'));
    if (!hubContainer) throw new Error('Hub container not found on this host');
    containerId = hubContainer.Id;
  } else {
    throw new Error(`Unknown update target: ${target}`);
  }

  logger.info('updater', `Updating ${target} container ${containerId.slice(0, 12)} to ${image}`);

  const container = docker.getContainer(containerId);
  const info = await container.inspect();
  const oldName = info.Name.replace(/^\//, '');

  // 1. Pull new image
  logger.info('updater', `Pulling ${image}...`);
  await new Promise((resolve, reject) => {
    docker.pull(image, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (err2) => {
        if (err2) return reject(err2);
        resolve(undefined);
      });
    });
  });
  logger.info('updater', `Pull complete: ${image}`);

  // 2. Stop old container
  try { await container.stop({ t: 5 }); } catch { /* already stopped */ }

  // 3. Rename old container to free the name
  try { await container.rename({ name: oldName + '-old' }); } catch { /* rename failed */ }

  // 4. Create and start new container with same config
  const createOpts = {
    name: oldName,
    Image: image,
    Env: info.Config.Env,
    Labels: { ...(info.Config.Labels || {}), 'insightd.updated-from': containerId.slice(0, 12) },
    HostConfig: {
      Binds: info.HostConfig.Binds,
      RestartPolicy: info.HostConfig.RestartPolicy,
      NetworkMode: info.HostConfig.NetworkMode,
      PortBindings: info.HostConfig.PortBindings,
      Privileged: info.HostConfig.Privileged,
    },
  };

  const newContainer = await docker.createContainer(createOpts);
  await newContainer.start();
  logger.info('updater', `New container started: ${newContainer.id.slice(0, 12)}`);

  // 5. For non-self updates, remove old container. For self-updates, we're about to die.
  if (target !== 'agent') {
    try {
      await container.remove({ force: true });
      logger.info('updater', `Old container removed`);
    } catch (err) {
      logger.warn('updater', `Failed to remove old container: ${err.message}`);
    }
  }

  return { status: 'success', message: `Updated to ${image}` };
}

/**
 * Clean up leftover containers from previous updates.
 * Called on agent startup.
 */
async function cleanupOldContainers(docker) {
  try {
    const containers = await docker.listContainers({ all: true });
    for (const c of containers) {
      const name = (c.Names[0] || '').replace(/^\//, '');
      if (name.endsWith('-old') && name.startsWith('insightd-')) {
        logger.info('updater', `Cleaning up old container: ${name}`);
        try {
          await docker.getContainer(c.Id).remove({ force: true });
        } catch (err) {
          logger.warn('updater', `Failed to remove ${name}: ${err.message}`);
        }
      }
    }
  } catch { /* ignore cleanup errors */ }
}

module.exports = { performUpdate, cleanupOldContainers };
