const https = require('https');
const logger = require('../utils/logger');
const { safeCollect } = require('../utils/errors');

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function httpHead(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'HEAD', headers }, (res) => {
      resolve({ status: res.statusCode, headers: res.headers });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

/**
 * Parse image string into registry, repo, and tag.
 * Only supports Docker Hub for MVP.
 */
function parseImage(image) {
  // Remove digest if present
  const noDigest = image.split('@')[0];
  const parts = noDigest.split(':');
  const tag = parts.length > 1 ? parts[parts.length - 1] : 'latest';
  let repo = parts.slice(0, -1).join(':') || parts[0];

  // If no slash, it's a Docker Hub official image
  if (!repo.includes('/')) {
    repo = `library/${repo}`;
  }

  // Check if it's a Docker Hub image (no domain with dots)
  const firstPart = repo.split('/')[0];
  if (firstPart.includes('.')) {
    return null; // Non-Docker Hub registry, skip for MVP
  }

  return { repo, tag };
}

async function getDockerHubToken(repo) {
  const url = `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`;
  const res = await httpGet(url);
  if (res.status !== 200) throw new Error(`Auth failed: ${res.status}`);
  return JSON.parse(res.body).token;
}

async function getRemoteDigest(repo, tag, token) {
  const url = `https://registry-1.docker.io/v2/${repo}/manifests/${tag}`;
  const res = await httpHead(url, {
    Authorization: `Bearer ${token}`,
    Accept: [
      'application/vnd.docker.distribution.manifest.v2+json',
      'application/vnd.docker.distribution.manifest.list.v2+json',
      'application/vnd.oci.image.index.v1+json',
    ].join(', '),
  });
  if (res.status === 429) throw new Error('Rate limited by Docker Hub');
  if (res.status !== 200) throw new Error(`Registry returned ${res.status}`);
  return res.headers['docker-content-digest'] || null;
}

async function checkUpdates(db, docker) {
  const containers = await docker.listContainers({ all: true });

  const insert = db.prepare(`
    INSERT INTO update_checks (container_name, image, local_digest, remote_digest, has_update, checked_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);

  // Deduplicate by image
  const seen = new Set();
  let checked = 0;
  let updatesFound = 0;

  for (const c of containers) {
    const name = (c.Names[0] || '').replace(/^\//, '');
    const image = c.Image;

    if (seen.has(image)) continue;
    seen.add(image);

    await safeCollect(`updates:${name}`, async () => {
      const parsed = parseImage(image);
      if (!parsed) {
        logger.info('updates', `Skipping non-Docker Hub image: ${image}`);
        return;
      }

      // Get local digest
      const imageInfo = await docker.getImage(image).inspect();
      const localDigest = (imageInfo.RepoDigests || [])
        .find(d => d.includes(parsed.repo))
        ?.split('@')[1] || null;

      // Get remote digest
      const token = await getDockerHubToken(parsed.repo);
      const remoteDigest = await getRemoteDigest(parsed.repo, parsed.tag, token);

      const hasUpdate = localDigest && remoteDigest && localDigest !== remoteDigest ? 1 : 0;
      if (hasUpdate) updatesFound++;

      insert.run(name, image, localDigest, remoteDigest, hasUpdate);
      checked++;

      const status = hasUpdate ? 'UPDATE AVAILABLE' : 'up to date';
      logger.info('updates', `${name} (${image}): ${status}`);
    });
  }

  logger.info('updates', `Checked ${checked} images, ${updatesFound} updates available`);
}

module.exports = { checkUpdates, parseImage };
