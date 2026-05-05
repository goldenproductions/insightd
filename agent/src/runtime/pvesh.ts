/**
 * Shared pvesh helper. Both ProxmoxRuntime (guests) and the cluster-scoped
 * collectors in `agent/src/collectors/proxmox-cluster.ts` (storage, ZFS,
 * cluster status) shell out to pvesh — keeping the spawn plumbing in one
 * place avoids drift in timeout/maxBuffer/path handling.
 *
 * Reads `child_process.execFile` lazily inside the call (rather than
 * destructuring at module load) so tests can replace the export via
 * `mock.method` without race conditions around when the require-cache was
 * busted. PR1 lessons learned.
 */

const PVESH_PATH = '/usr/bin/pvesh';
const PVESH_TIMEOUT_MS = 10_000;
const PVESH_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * Run `pvesh get <path> --output-format json` and parse the result.
 * Throws if pvesh exits non-zero, the JSON is malformed, or the call times out.
 */
export async function pvesh<T>(path: string): Promise<T> {
  const { execFile } = require('child_process') as typeof import('child_process');
  const stdout: string = await new Promise((resolve, reject) => {
    execFile(
      PVESH_PATH,
      ['get', path, '--output-format', 'json'],
      { timeout: PVESH_TIMEOUT_MS, maxBuffer: PVESH_MAX_BUFFER },
      (err, out) => {
        // execFile with default options returns stdout as a string.
        if (err) reject(err);
        else resolve(out);
      },
    );
  });
  return JSON.parse(stdout) as T;
}
