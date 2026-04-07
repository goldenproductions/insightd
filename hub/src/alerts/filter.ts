/**
 * Check if a container name matches any exclude pattern.
 * Patterns are comma-separated with * wildcard support.
 * E.g. "dev-*,test-*,insightd-*" excludes dev-nginx, test-app, insightd-hub.
 *
 * @param containerName
 * @param patterns - comma-separated glob patterns
 * @returns true if container should be excluded
 */
function isExcluded(containerName: string, patterns: string): boolean {
  if (!patterns || !patterns.trim()) return false;

  const list = patterns.split(',').map(p => p.trim()).filter(Boolean);
  for (const pattern of list) {
    const regex = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    if (regex.test(containerName)) return true;
  }
  return false;
}

module.exports = { isExcluded };
