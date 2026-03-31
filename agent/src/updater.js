const logger = require('../../shared/utils/logger');
const { config } = require('./config');

/**
 * Perform a container self-update: pull new image, recreate with same config.
 * Works for both agent self-update and hub container update.
 */
async function performUpdate(docker, target, image) {
  if (!config.allowUpdates) {
    throw new Error('Updates not enabled (set INSIGHTD_ALLOW_UPDATES=true)');
  }

  // Validate image name
  if (!image.startsWith('andreas404/insightd-')) {
    throw new Error(`Invalid image: ${image}. Only andreas404/insightd-* images allowed.`);
  }

  // Determine which container to update
  let containerId;
  if (target === 'agent') {
    containerId = process.env.HOSTNAME;
    if (!containerId) throw new Error('Cannot determine own container ID (HOSTNAME not set)');
  } else if (target === 'hub') {
    // Find the hub container by image name
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

  // 3. Build new container config from old one
  const createOpts = {
    name: info.Name.replace(/^\//, '') + '-update',
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

  // 4. Create new container
  logger.info('updater', `Creating new container with image ${image}`);
  const newContainer = await docker.createContainer(createOpts);

  // 5. Start new container
  await newContainer.start();
  logger.info('updater', `New container started: ${newContainer.id.slice(0, 12)}`);

  // 6. Stop old container (new one takes over)
  // Rename old container first so new one can take its name
  const oldName = info.Name.replace(/^\//, '');
  try {
    await container.rename({ name: oldName + '-old' });
    await newContainer.rename({ name: oldName });
  } catch (err) {
    logger.warn('updater', `Rename failed: ${err.message}. Container running with temp name.`);
  }

  // 7. Stop and remove old container
  try {
    await container.stop({ t: 5 });
    await container.remove();
    logger.info('updater', `Old container removed`);
  } catch (err) {
    logger.warn('updater', `Failed to stop/remove old container: ${err.message}`);
  }

  return { status: 'success', message: `Updated to ${image}` };
}

module.exports = { performUpdate };
