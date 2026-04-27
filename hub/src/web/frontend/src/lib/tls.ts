import type { Endpoint } from '@/types/api';

export type TlsState = 'unknown' | 'valid' | 'expiring' | 'expired' | 'invalid';

export interface TlsStatus {
  state: TlsState;
  /** Whole days until expiry (negative if expired). NaN if no expiry known. */
  daysLeft: number;
  /** Short human-readable label, e.g. "30d", "expired", "self-signed". */
  label: string;
  /** Tailwind utility class for badge background+text — calm by default, alarming when bad. */
  tone: 'muted' | 'warning' | 'danger';
}

const TRANSIENT_TLS_ERRORS = new Set([
  'timeout', 'tls-error',
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
]);

/**
 * Derive cert status for an https endpoint. Returns null for non-https or
 * endpoints that haven't been probed yet — the UI should hide the badge.
 */
export function getTlsStatus(ep: Pick<Endpoint, 'url' | 'tls_expires_at' | 'tls_last_checked_at' | 'tls_error'>, warnDays: number = 14): TlsStatus | null {
  if (!ep.url.startsWith('https://')) return null;
  if (!ep.tls_last_checked_at) return null;

  const expiryMs = ep.tls_expires_at ? Date.parse(ep.tls_expires_at) : NaN;
  const hasExpiry = Number.isFinite(expiryMs);
  const daysLeft = hasExpiry ? Math.floor((expiryMs - Date.now()) / 86400000) : NaN;

  if (ep.tls_error === 'expired' || (hasExpiry && expiryMs < Date.now())) {
    return { state: 'expired', daysLeft, label: 'expired', tone: 'danger' };
  }
  if (ep.tls_error && !TRANSIENT_TLS_ERRORS.has(ep.tls_error)) {
    return { state: 'invalid', daysLeft, label: ep.tls_error, tone: 'danger' };
  }
  if (ep.tls_error && TRANSIENT_TLS_ERRORS.has(ep.tls_error)) {
    // Transient probe error — don't shout. Show last known days if we have them.
    if (hasExpiry) return { state: 'valid', daysLeft, label: `${daysLeft}d`, tone: 'muted' };
    return { state: 'unknown', daysLeft: NaN, label: 'unknown', tone: 'muted' };
  }
  if (!hasExpiry) {
    return { state: 'unknown', daysLeft: NaN, label: 'no cert', tone: 'muted' };
  }
  if (daysLeft <= warnDays) {
    return { state: 'expiring', daysLeft, label: `${daysLeft}d`, tone: 'warning' };
  }
  return { state: 'valid', daysLeft, label: `${daysLeft}d`, tone: 'muted' };
}

export function tlsBadgeClass(tone: TlsStatus['tone']): string {
  switch (tone) {
    case 'danger':  return 'bg-danger/10 text-danger';
    case 'warning': return 'bg-warning/10 text-warning';
    default:        return 'bg-bg-secondary text-secondary';
  }
}
