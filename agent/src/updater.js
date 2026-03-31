const logger = require('../../shared/utils/logger');
const { config } = require('./config');

/**
 * Perform a container self-update: pull new image, recreate with same config.
 */
async function performUpdate(docker, target, image) {
  if (!config.allowUpdates) {
    throw new Error('Updates not enabled (set INSIGHTD_ALLOW_UPDATES=true)');
  }

  if (!image.startsWith('andreas404/insightd-')) {
    throw new Error(`Invalid image: ${image}. Only andreas404/insightd-* images allowed.`);
  }

  // Determine which container to update
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

  // 1. Inspect current container to capture config
  const container = docker.getContainer(containerId);
  const info = await container.inspect();
  const oldName = info.Name.replace(/^\//, '');

  // 2. Pull new image
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

  // 3. Stop old container first
  logger.info('updater', `Stopping old container ${oldName}...`);
  try {
    await container.stop({ t: 5 });
  } catch {
    // Already stopped
  }

  // 4. Rename old container
  try {
    await container.rename({ name: oldName + '-removing' });
  } catch {
    // Rename failed, continue anyway
  }

  // 5. Create new container with same config
  const createOpts = {
    name: oldName,
    Image: image,
    Env: info.Config.Env,
    Labels: info.Config.Labels || {},
    HostConfig: {
      Binds: info.HostConfig.Binds,
      RestartPolicy: info.HostConfig.RestartPolicy,
      NetworkMode: info.HostConfig.NetworkMode,
      PortBindings: info.HostConfig.PortBindings,
      Privileged: info.HostConfig.Privileged,
    },
  };

  logger.info('updater', `Creating new container with image ${image}`);
  const newContainer = await docker.createContainer(createOpts);
  await newContainer.start();
  logger.info('updater', `New container started: ${newContainer.id.slice(0, 12)}`);

  // 6. Remove old container
  try {
    await container.remove({ force: true });
    logger.info('updater', `Old container removed`);
  } catch (err) {
    logger.warn('updater', `Failed to remove old container: ${err.message}`);
  }

  return { status: 'success', message: `Updated to ${image}` };
}

module.exports = { performUpdate };
