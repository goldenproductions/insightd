import https = require('https');
import logger = require('../../../shared/utils/logger');
import type Dockerode from 'dockerode';
import type { IncomingMessage } from 'http';

const { safeCollect } = require('../../../shared/utils/errors') as { safeCollect: <T>(label: string, fn: () => Promise<T>) => Promise<T | null> };

interface HttpResponse {
  status: number | undefined;
  headers: IncomingMessage['headers'];
  body: string;
}

interface HttpHeadResponse {
  status: number | undefined;
  headers: IncomingMessage['headers'];
}

function httpGet(url: string, headers: Record<string, string> = {}): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (chunk: string) => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function httpHead(url: string, headers: Record<string, string> = {}): Promise<HttpHeadResponse> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'HEAD', headers }, (res) => {
      resolve({ status: res.statusCode, headers: res.headers });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function parseImage(image: string): { repo: string; tag: string } | null {
  const noDigest = image.split('@')[0];
  const parts = noDigest.split(':');
  const tag = parts.length > 1 ? parts[parts.length - 1] : 'latest';
  let repo = parts.slice(0, -1).join(':') || parts[0];

  if (!repo.includes('/')) {
    repo = `library/${repo}`;
  }

  const firstPart = repo.split('/')[0];
  if (firstPart.includes('.')) {
    return null;
  }

  return { repo, tag };
}

async function getDockerHubToken(repo: string): Promise<string> {
  const url = `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`;
  const res = await httpGet(url);
  if (res.status !== 200) throw new Error(`Auth failed: ${res.status}`);
  return JSON.parse(res.body).token;
}

async function getRemoteDigest(repo: string, tag: string, token: string): Promise<string | null> {
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
  return (res.headers['docker-content-digest'] as string) || null;
}

interface UpdateResult {
  containerName: string;
  image: string;
  localDigest: string | null;
  remoteDigest: string | null;
  hasUpdate: boolean;
}

/**
 * Check for available image updates.
 * Returns plain data array — no DB writes.
 */
async function checkUpdates(docker: Dockerode): Promise<UpdateResult[]> {
  const containers = await docker.listContainers({ all: true });
  const results: UpdateResult[] = [];

  const seen = new Set<string>();
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

      const imageInfo = await docker.getImage(image).inspect();
      const localDigest = (imageInfo.RepoDigests || [])
        .find(d => d.includes(parsed.repo))
        ?.split('@')[1] || null;

      const token = await getDockerHubToken(parsed.repo);
      const remoteDigest = await getRemoteDigest(parsed.repo, parsed.tag, token);

      const hasUpdate = !!(localDigest && remoteDigest && localDigest !== remoteDigest);
      if (hasUpdate) updatesFound++;

      results.push({
        containerName: name,
        image,
        localDigest,
        remoteDigest,
        hasUpdate,
      });
      checked++;

      const status = hasUpdate ? 'UPDATE AVAILABLE' : 'up to date';
      logger.info('updates', `${name} (${image}): ${status}`);
    });
  }

  logger.info('updates', `Checked ${checked} images, ${updatesFound} updates available`);
  return results;
}

module.exports = { checkUpdates, parseImage };
