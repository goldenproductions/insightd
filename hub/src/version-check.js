const logger = require('../../shared/utils/logger');
const { VERSION } = require('./config');

let latestVersion = null;
let latestCheckedAt = null;

/**
 * Check Docker Hub for the latest insightd-hub semver tag.
 */
async function checkForUpdates() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch('https://hub.docker.com/v2/repositories/andreas404/insightd-hub/tags/?page_size=10&ordering=last_updated', {
      headers: { 'User-Agent': 'insightd' },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      logger.warn('version-check', `Docker Hub API returned ${res.status}`);
      return;
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

    if (tags.length === 0) {
      logger.info('version-check', 'No semver tags found on Docker Hub');
      return;
    }

    latestVersion = tags[0] || null;
    latestCheckedAt = new Date().toISOString();

    if (latestVersion !== VERSION) {
      logger.info('version-check', `New version available: ${latestVersion} (current: ${VERSION})`);
    } else {
      logger.info('version-check', `Up to date: ${VERSION}`);
    }
  } catch (err) {
    logger.warn('version-check', `Failed to check for updates: ${err.message}`);
  }
}

function getVersionInfo() {
  return {
    currentVersion: VERSION,
    latestVersion,
    updateAvailable: latestVersion ? latestVersion !== VERSION : false,
    checkedAt: latestCheckedAt,
  };
}

module.exports = { checkForUpdates, getVersionInfo };
