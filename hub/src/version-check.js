const logger = require('../../shared/utils/logger');
const { VERSION } = require('./config');

let latestHubVersion = null;
let latestAgentVersion = null;
let latestCheckedAt = null;

/**
 * Fetch the latest semver tag from a Docker Hub repository.
 */
async function fetchLatestTag(repo) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(`https://hub.docker.com/v2/repositories/${repo}/tags/?page_size=10&ordering=last_updated`, {
      headers: { 'User-Agent': 'insightd' },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      logger.warn('version-check', `Docker Hub API returned ${res.status} for ${repo}`);
      return null;
    }

    const data = await res.json();
    const tags = (data.results || [])
      .map(t => t.name)
      .filter(t => /^\d+\.\d+\.\d+$/.test(t))
      .sort((a, b) => {
        const pa = a.split('.').map(Number);
        const pb = b.split('.').map(Number);
        for (let i = 0; i < 3; i++) {
          if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
        }
        return 0;
      });

    return tags[0] || null;
  } catch (err) {
    logger.warn('version-check', `Failed to fetch tags for ${repo}: ${err.message}`);
    return null;
  }
}

/**
 * Check Docker Hub for the latest insightd-hub and insightd-agent semver tags.
 */
async function checkForUpdates() {
  const [hub, agent] = await Promise.all([
    fetchLatestTag('andreas404/insightd-hub'),
    fetchLatestTag('andreas404/insightd-agent'),
  ]);

  if (hub !== null) latestHubVersion = hub;
  if (agent !== null) latestAgentVersion = agent;
  latestCheckedAt = new Date().toISOString();

  if (latestHubVersion && latestHubVersion !== VERSION) {
    logger.info('version-check', `New hub version available: ${latestHubVersion} (current: ${VERSION})`);
  } else {
    logger.info('version-check', `Hub up to date: ${VERSION}`);
  }

  if (latestAgentVersion) {
    logger.info('version-check', `Latest agent version: ${latestAgentVersion}`);
  }
}

function getVersionInfo() {
  return {
    currentVersion: VERSION,
    latestHubVersion,
    latestAgentVersion,
    hubUpdateAvailable: latestHubVersion ? latestHubVersion !== VERSION : false,
    checkedAt: latestCheckedAt,
    // Backward compat
    latestVersion: latestHubVersion,
    updateAvailable: latestHubVersion ? latestHubVersion !== VERSION : false,
  };
}

module.exports = { checkForUpdates, getVersionInfo };
