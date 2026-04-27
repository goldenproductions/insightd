import type Database from 'better-sqlite3';
import * as tls from 'node:tls';
import logger = require('../../../shared/utils/logger');

interface HttpEndpoint {
  id: number;
  name: string;
  url: string;
  enabled: number;
  tls_last_checked_at: string | null;
}

export interface TlsResult {
  expiresAt: string | null;       // ISO timestamp of `not_after`
  issuer: string | null;          // issuer CN (or O if CN missing)
  subjectAltNames: string | null; // CSV
  error: string | null;           // 'self-signed' | 'hostname-mismatch' | 'untrusted-root' | 'expired' | other
}

const TLS_PROBE_TIMEOUT_MS = 10000;

function parseHostPort(rawUrl: string): { host: string; port: number } | null {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:') return null;
    const port = u.port ? Number(u.port) : 443;
    if (!u.hostname || !Number.isFinite(port)) return null;
    return { host: u.hostname, port };
  } catch {
    return null;
  }
}

function classifyAuthError(code: string | undefined): string {
  switch (code) {
    case 'CERT_HAS_EXPIRED': return 'expired';
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN': return 'self-signed';
    case 'UNABLE_TO_GET_ISSUER_CERT':
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE': return 'untrusted-root';
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
    case 'HOSTNAME_MISMATCH': return 'hostname-mismatch';
    default: return code || 'tls-error';
  }
}

/**
 * Probe a single https URL for cert metadata. Connects with rejectUnauthorized:false
 * so we can retrieve the cert even when it's invalid, then surfaces the
 * authorization status as a structured error.
 *
 * SECURITY: rejectUnauthorized:false is intentional and required for this feature.
 * This is a TLS *monitoring* probe whose entire purpose is to detect and report
 * invalid certs (self-signed, expired, hostname-mismatch, untrusted-root) so the
 * user gets a `cert_invalid` / `cert_expired` alert. If we let Node reject
 * invalid certs, the connection would fail before getPeerCertificate() returns,
 * and the user would only see "endpoint down" with no diagnostic — strictly
 * worse for them, not better.
 *
 * The MITM threat model that CodeQL js/disabling-certificate-validation warns
 * about does not apply here:
 *   - Read-only handshake: we never send a request body, headers, or credentials.
 *   - Immediate close: socket.end() is called as soon as the cert is read.
 *   - The validation result is *recorded and surfaced* as an alert, not silently
 *     ignored — so MITM-as-a-result-of-invalid-cert is precisely what we report on.
 *   - Connection has a 10s timeout cap.
 */
export function probeTls(url: string): Promise<TlsResult> {
  const target = parseHostPort(url);
  if (!target) {
    return Promise.resolve({ expiresAt: null, issuer: null, subjectAltNames: null, error: 'not-https' });
  }

  return new Promise(resolve => {
    let settled = false;
    const finish = (r: TlsResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    const socket = tls.connect({
      host: target.host,
      port: target.port,
      servername: target.host,
      // rejectUnauthorized:false is required to inspect invalid certs — see SECURITY note above.
      rejectUnauthorized: false,
      timeout: TLS_PROBE_TIMEOUT_MS,
    }, () => {
      const cert = socket.getPeerCertificate(true);
      socket.end();

      if (!cert || Object.keys(cert).length === 0) {
        finish({ expiresAt: null, issuer: null, subjectAltNames: null, error: 'no-cert' });
        return;
      }

      const expiresAt = cert.valid_to ? new Date(cert.valid_to).toISOString() : null;
      const issuerRaw = (cert.issuer?.CN || cert.issuer?.O) as string | string[] | undefined;
      const issuer = Array.isArray(issuerRaw) ? (issuerRaw[0] || null) : (issuerRaw || null);
      const rawSans = cert.subjectaltname;
      const sansStr = Array.isArray(rawSans) ? rawSans.join(',') : (rawSans || '');
      const sans = sansStr
        ? sansStr.split(',').map((s: string) => s.trim().replace(/^DNS:/, '')).filter(Boolean).join(',')
        : null;

      let err: string | null = null;
      if (!socket.authorized) {
        // authorizationError can be an Error or a string code on older Node
        const ae: any = socket.authorizationError;
        const code = typeof ae === 'string' ? ae : ae?.code || ae?.message;
        err = classifyAuthError(code);
      } else if (expiresAt && Date.parse(expiresAt) < Date.now()) {
        err = 'expired';
      }
      finish({ expiresAt, issuer, subjectAltNames: sans, error: err });
    });

    socket.on('timeout', () => {
      socket.destroy();
      finish({ expiresAt: null, issuer: null, subjectAltNames: null, error: 'timeout' });
    });

    socket.on('error', err => {
      const code = (err as NodeJS.ErrnoException).code;
      finish({ expiresAt: null, issuer: null, subjectAltNames: null, error: code || err.message || 'tls-error' });
    });
  });
}

function persistResult(db: Database.Database, endpointId: number, r: TlsResult): void {
  db.prepare(`
    UPDATE http_endpoints
       SET tls_expires_at = ?,
           tls_issuer = ?,
           tls_subject_alt_names = ?,
           tls_last_checked_at = datetime('now'),
           tls_error = ?
     WHERE id = ?
  `).run(r.expiresAt, r.issuer, r.subjectAltNames, r.error, endpointId);
}

/**
 * Run TLS probes for any https endpoint that hasn't been checked within the
 * configured interval. Non-https endpoints are skipped entirely (and any stale
 * tls fields are cleared so the UI doesn't show ghosts).
 */
export async function runTlsChecks(db: Database.Database, intervalHours: number): Promise<void> {
  const interval = Math.max(1, intervalHours);
  const rows = db.prepare(`
    SELECT id, name, url, enabled, tls_last_checked_at
    FROM http_endpoints
    WHERE enabled = 1
  `).all() as HttpEndpoint[];

  const due: HttpEndpoint[] = [];
  for (const ep of rows) {
    if (!ep.url.startsWith('https://')) {
      // Clear once if the endpoint was previously https → http.
      if (ep.tls_last_checked_at) {
        db.prepare(`
          UPDATE http_endpoints
             SET tls_expires_at = NULL, tls_issuer = NULL, tls_subject_alt_names = NULL,
                 tls_last_checked_at = NULL, tls_error = NULL
           WHERE id = ?
        `).run(ep.id);
      }
      continue;
    }
    if (!ep.tls_last_checked_at) {
      due.push(ep);
      continue;
    }
    const last = new Date(ep.tls_last_checked_at + 'Z').getTime();
    if (Number.isFinite(last) && (Date.now() - last) >= interval * 3600 * 1000) {
      due.push(ep);
    }
  }

  if (due.length === 0) return;

  const CONCURRENCY = 5;
  for (let i = 0; i < due.length; i += CONCURRENCY) {
    const batch = due.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(ep => probeTls(ep.url).then(r => ({ ep, r })))
    );
    for (const res of results) {
      if (res.status === 'fulfilled') {
        const { ep, r } = res.value;
        persistResult(db, ep.id, r);
        const detail = r.error
          ? `error=${r.error}`
          : r.expiresAt ? `expires=${r.expiresAt.slice(0, 10)} issuer=${r.issuer || '?'}` : 'no-cert';
        logger.info('tls-check', `${ep.name}: ${detail}`);
      } else {
        logger.error('tls-check', `Probe failed unexpectedly: ${res.reason}`);
      }
    }
  }
}

module.exports = { probeTls, runTlsChecks };
