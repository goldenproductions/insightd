/**
 * PVE API helper with a transport-pluggable backend. Both ProxmoxRuntime and
 * the cluster-scoped collectors at `agent/src/collectors/proxmox-cluster.ts`
 * call `pveApi(path)` to read PVE state. The same call site works in two
 * deployment modes:
 *
 *   - **local-shell** — the agent runs on the PVE hypervisor itself and
 *     shells out to `/usr/bin/pvesh`. This was the only mode pre-PR5;
 *     `pvesh.ts` is now a one-line shim re-exporting from this module.
 *   - **rest-api** — the agent runs anywhere with reachability to PVE's
 *     web port (default 8006) and authenticates with an API token. No
 *     install on the hypervisor.
 *
 * Mode is selected by env vars at agent startup (see `agent/src/config.ts`):
 * if `INSIGHTD_PVE_API_URL` is set, REST mode wins; otherwise local-shell.
 *
 * Why a transport interface (not just a flag in one function): the local
 * path is mocked at the `child_process.execFile` boundary in existing tests,
 * the REST path is mocked at the `https.request` boundary in new tests.
 * Keeping them as discrete implementations means each test file mocks one
 * surface only, with no spillover.
 *
 * Lazy require()s inside the call sites keep the test mocks honest — same
 * lesson as PR1's pvesh.ts: destructured top-level bindings don't see
 * `mock.method` updates after a require-cache bust.
 */

import logger = require('../../../shared/utils/logger');

export interface PveApiConfig {
  /** When set, switch to REST transport. Format: `https://host:port`. */
  url?: string;
  /** PVE token identifier in the form `user@realm!tokenid`. */
  tokenId?: string;
  /** PVE token secret (UUID-ish opaque string). */
  tokenSecret?: string;
  /** Default false — most PVE installs use the auto-generated self-signed
   *  cert. Set true once you've configured Let's Encrypt or pinned a CA. */
  verifyTls?: boolean;
  /** Path to a PEM CA bundle. Only consulted when verifyTls=true. */
  caBundle?: string;
}

export type PveActionMethod = 'POST' | 'DELETE';

export interface Transport {
  /** Diagnostic label for `init()` log lines. */
  readonly mode: 'local-shell' | 'rest-api';
  /** GET <path> and return the parsed (and, in REST mode, unwrapped) body. */
  get<T>(path: string): Promise<T>;
  /**
   * POST or DELETE <path> with an optional form-encoded body. Used for
   * actions (start / shutdown / reboot / destroy). The local-shell
   * transport throws — actions go through `pct`/`qm` directly from
   * ProxmoxRuntime in that mode, not through pvesh.
   */
  action(method: PveActionMethod, path: string, body?: Record<string, string>): Promise<unknown>;
}

let transport: Transport | null = null;
let configured: PveApiConfig = {};
let testOverride: Transport | null = null;

/**
 * Apply runtime config. Called by ProxmoxRuntime's constructor with the
 * env-derived values. Resets the cached transport so the next pveApi call
 * rebuilds with the new config — but does NOT clear a test override
 * installed via __setTestTransport, so tests can construct runtimes
 * without losing their fake transport.
 */
export function configurePveTransport(cfg: PveApiConfig): void {
  configured = cfg;
  transport = null;
}

/**
 * Test-only: inject a fake transport. Stays set across configurePveTransport
 * calls (so a test can construct ProxmoxRuntime AFTER calling this without
 * the constructor wiping the fake). Pass null to clear.
 */
export function __setTestTransport(t: Transport | null): void {
  testOverride = t;
}

function getTransport(): Transport {
  if (testOverride) return testOverride;
  if (transport) return transport;
  transport = configured.url
    ? createRestTransport(configured)
    : createLocalShellTransport();
  return transport;
}

/** Drop-in replacement for the old `pvesh()` helper. */
export async function pveApi<T>(path: string): Promise<T> {
  return getTransport().get<T>(path);
}

/**
 * Write-side API. ProxmoxRuntime.performAction routes through this in REST
 * mode; in local-shell mode it bypasses (calls pct/qm directly) because
 * pvesh's CLI doesn't model the "POST /status/start" idiom cleanly.
 */
export async function pveAction(method: PveActionMethod, path: string, body?: Record<string, string>): Promise<unknown> {
  return getTransport().action(method, path, body);
}

/** True if the active transport is REST mode (helps ProxmoxRuntime pick its branches). */
export function isRestMode(): boolean {
  return getTransport().mode === 'rest-api';
}

// ─────────────────────────────────────────────────────────────────────────
// Local-shell transport
// ─────────────────────────────────────────────────────────────────────────

const PVESH_PATH = '/usr/bin/pvesh';
const PVESH_TIMEOUT_MS = 10_000;
const PVESH_MAX_BUFFER = 8 * 1024 * 1024;

function createLocalShellTransport(): Transport {
  return {
    mode: 'local-shell',
    async get<T>(path: string): Promise<T> {
      const { execFile } = require('child_process') as typeof import('child_process');
      const stdout: string = await new Promise((resolve, reject) => {
        execFile(
          PVESH_PATH,
          ['get', path, '--output-format', 'json'],
          { timeout: PVESH_TIMEOUT_MS, maxBuffer: PVESH_MAX_BUFFER },
          (err, out) => err ? reject(err) : resolve(out),
        );
      });
      return JSON.parse(stdout) as T;
    },
    async action(_method, _path, _body) {
      // Local-shell mode runs actions via pct/qm in ProxmoxRuntime directly.
      // Calling action() here is a programmer error — would silently succeed
      // with no observable effect on PVE. Throw so the caller learns now.
      throw new Error(
        'local-shell transport does not implement action(); ProxmoxRuntime.performAction must shell pct/qm directly in local mode'
      );
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// REST transport — pure Node `https`, no new deps.
// ─────────────────────────────────────────────────────────────────────────

const ACTION_TIMEOUT_MS = 30_000;

interface RestRequestResult {
  status: number;
  body: string;
}

function createRestTransport(cfg: PveApiConfig): Transport {
  // configurePveTransport callers should have validated these, but defend
  // anyway so a misconfigured env doesn't surface as a confusing TypeError.
  if (!cfg.url) throw new Error('REST transport requires INSIGHTD_PVE_API_URL');
  if (!cfg.tokenId || !cfg.tokenSecret) {
    throw new Error('REST transport requires INSIGHTD_PVE_TOKEN_ID and INSIGHTD_PVE_TOKEN_SECRET');
  }

  const parsed = new URL(cfg.url);
  const port = parsed.port ? Number(parsed.port) : 8006;
  const verifyTls = cfg.verifyTls === true;
  const authHeader = `PVEAPIToken=${cfg.tokenId}=${cfg.tokenSecret}`;

  // One https.Agent per transport instance, keepAlive on. PVE's TLS handshake
  // adds 50–100ms per cold call; the per-cycle pattern (one node-status +
  // one cluster-resources + per-guest snapshot calls) benefits a lot.
  // Built lazily so test instances that immediately swap transports don't
  // hold open sockets.
  let httpsAgent: any | null = null;
  function getAgent(): any {
    if (httpsAgent) return httpsAgent;
    const https = require('https') as typeof import('https');
    const fs = require('fs') as typeof import('fs');
    const opts: any = { keepAlive: true, rejectUnauthorized: verifyTls };
    if (verifyTls && cfg.caBundle) {
      try { opts.ca = fs.readFileSync(cfg.caBundle); }
      catch (err) {
        logger.warn('proxmox', `Failed to read CA bundle ${cfg.caBundle}: ${(err as Error).message}`);
      }
    }
    httpsAgent = new https.Agent(opts);
    return httpsAgent;
  }

  function request(method: string, path: string, body: string | undefined, timeoutMs: number): Promise<RestRequestResult> {
    return new Promise((resolve, reject) => {
      const https = require('https') as typeof import('https');
      const headers: Record<string, string | number> = {
        'Authorization': authHeader,
        'Accept': 'application/json',
      };
      if (body !== undefined) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        headers['Content-Length'] = Buffer.byteLength(body);
      }
      const req = https.request({
        host: parsed.hostname,
        port,
        path: '/api2/json' + path,
        method,
        agent: getAgent(),
        headers,
      } as any, (res: any) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode || 0,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`PVE API ${method} ${path} timed out after ${timeoutMs}ms`)));
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  /** Strip PVE's `{ "data": ... }` envelope. Endpoints that error out may
   *  return non-JSON bodies; we tolerate those by returning the raw body. */
  function unwrap(raw: string): unknown {
    let parsed: any;
    try { parsed = JSON.parse(raw); }
    catch { return raw; }
    return parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed;
  }

  /** Pull a useful detail string out of a PVE error response. */
  function describeError(method: string, path: string, status: number, body: string): Error {
    let detail = body;
    try {
      const parsed = JSON.parse(body);
      // PVE error envelope variants:
      //   { "data": null, "errors": { "field": "message", ... } }
      //   { "message": "...short..." }
      if (parsed && typeof parsed === 'object') {
        if (parsed.errors && typeof parsed.errors === 'object' && Object.keys(parsed.errors).length > 0) {
          detail = Object.entries(parsed.errors)
            .map(([k, v]) => `${k}: ${v}`)
            .join('; ');
        } else if (typeof parsed.message === 'string') {
          detail = parsed.message;
        }
      }
    } catch { /* non-JSON body, use raw */ }
    // Trim aggressively — long HTML 500 pages would otherwise dominate logs.
    return new Error(`PVE API ${method} ${path} returned ${status}: ${detail.slice(0, 500)}`);
  }

  return {
    mode: 'rest-api',
    async get<T>(path: string): Promise<T> {
      const { status, body } = await request('GET', path, undefined, PVESH_TIMEOUT_MS);
      if (status < 200 || status >= 300) throw describeError('GET', path, status, body);
      return unwrap(body) as T;
    },
    async action(method, path, body) {
      const encoded = body ? new URLSearchParams(body).toString() : undefined;
      const { status, body: respBody } = await request(method, path, encoded, ACTION_TIMEOUT_MS);
      if (status < 200 || status >= 300) throw describeError(method, path, status, respBody);
      return unwrap(respBody);
    },
  };
}
