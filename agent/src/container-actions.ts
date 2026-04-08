import logger = require('../../shared/utils/logger');
import type Dockerode from 'dockerode';

const { config } = require('./config') as { config: { allowActions: boolean } };

const VALID_ACTIONS = ['start', 'stop', 'restart', 'remove'] as const;
type ContainerAction = typeof VALID_ACTIONS[number];

async function performContainerAction(docker: Dockerode, containerName: string, action: string): Promise<{ status: string; message: string }> {
  if (!config.allowActions) {
    throw new Error('Container actions are disabled. Set INSIGHTD_ALLOW_ACTIONS=true to enable.');
  }

  if (!VALID_ACTIONS.includes(action as ContainerAction)) {
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

  // Block remove on running containers
  if (action === 'remove' && match.State === 'running') {
    throw new Error(`Container "${containerName}" is running. Stop it before removing.`);
  }

  const container = docker.getContainer(match.Id);

  logger.info('actions', `Performing ${action} on ${containerName} (${match.Id.slice(0, 12)})`);

  if (action === 'start') {
    await container.start();
  } else if (action === 'stop') {
    await container.stop({ t: 10 });
  } else if (action === 'restart') {
    await container.restart({ t: 10 });
  } else if (action === 'remove') {
    await container.remove();
  }

  const past = action === 'stop' ? 'stopped' : action === 'remove' ? 'removed' : `${action}ed`;
  logger.info('actions', `${action} completed on ${containerName}`);
  return { status: 'success', message: `Container "${containerName}" ${past} successfully` };
}

module.exports = { performContainerAction };
