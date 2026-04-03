const logger = require('../../shared/utils/logger');
const { config } = require('./config');

const VALID_ACTIONS = ['start', 'stop', 'restart'];

async function performContainerAction(docker, containerName, action) {
  if (!config.allowActions) {
    throw new Error('Container actions are disabled. Set INSIGHTD_ALLOW_ACTIONS=true to enable.');
  }

  if (!VALID_ACTIONS.includes(action)) {
    throw new Error(`Invalid action "${action}". Must be one of: ${VALID_ACTIONS.join(', ')}`);
  }

  // Find container by name
  const containers = await docker.listContainers({ all: true });
  const match = containers.find(c => c.Names.some(n => n === `/${containerName}` || n === containerName));
  if (!match) {
    throw new Error(`Container "${containerName}" not found`);
  }

  // Block actions on insightd internal containers
  if (match.Labels && match.Labels['insightd.internal'] === 'true') {
    throw new Error(`Cannot ${action} internal insightd container "${containerName}"`);
  }

  const container = docker.getContainer(match.Id);

  logger.info('actions', `Performing ${action} on ${containerName} (${match.Id.slice(0, 12)})`);

  if (action === 'start') {
    await container.start();
  } else if (action === 'stop') {
    await container.stop({ t: 10 });
  } else if (action === 'restart') {
    await container.restart({ t: 10 });
  }

  logger.info('actions', `${action} completed on ${containerName}`);
  return { status: 'success', message: `Container "${containerName}" ${action}ed successfully` };
}

module.exports = { performContainerAction };
