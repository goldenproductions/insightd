import type { MouseEvent } from 'react';
import type { Alert } from '@/types/api';
import { useAuth } from '@/context/AuthContext';
import { useSilenceAlert, type SilenceDuration } from '@/hooks/useSilenceAlert';

interface Preset {
  label: string;
  duration: SilenceDuration;
  title: string;
}

const PRESETS: Preset[] = [
  { label: '1h', duration: 60, title: 'Silence reminders for 1 hour' },
  { label: '4h', duration: 240, title: 'Silence reminders for 4 hours' },
  { label: '1d', duration: 1440, title: 'Silence reminders for 1 day' },
  { label: '7d', duration: 10080, title: 'Silence reminders for 7 days' },
  { label: '∞', duration: 'resolved', title: 'Silence reminders until the alert resolves naturally' },
];

const UNTIL_RESOLVED_SENTINEL = '9999-12-31 23:59:59';

function formatSilencedUntil(until: string): string {
  if (until >= UNTIL_RESOLVED_SENTINEL.slice(0, 4)) return 'until resolved';
  // Database stores "YYYY-MM-DD HH:MM:SS" in UTC; coerce to local for display.
  const d = new Date(until.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return `until ${until}`;
  const now = Date.now();
  const deltaMs = d.getTime() - now;
  if (deltaMs < 0) return 'until just now';
  const mins = Math.round(deltaMs / 60000);
  if (mins < 60) return `${mins}m remaining`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h remaining`;
  const days = Math.round(hours / 24);
  return `${days}d remaining`;
}

/**
 * Inline silence controls for an active alert row. Expects the alert object
 * and optional host/container context for query invalidation.
 *
 * Renders nothing for resolved alerts (there's nothing to silence).
 */
export function AlertSilenceControls({
  alert,
  hostId,
  containerName,
}: {
  alert: Alert;
  hostId?: string;
  containerName?: string;
}) {
  const { isAuthenticated, authEnabled } = useAuth();
  const { silence, unsilence, isPending } = useSilenceAlert(alert.id, hostId, containerName);

  // Nothing to silence on a resolved alert.
  if (alert.resolved_at != null) return null;

  // When auth is required and the user isn't logged in, show nothing — the
  // buttons would just bounce off the 401 anyway.
  if (authEnabled && !isAuthenticated) return null;

  const isSilenced = alert.silenced_until != null;

  // Stop click propagation so these controls don't bubble into any
  // whole-row onClick handlers (the AlertsPage row links to a detail page).
  const stop = (e: MouseEvent) => e.stopPropagation();

  if (isSilenced) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted" onClick={stop}>
        <span title={alert.silenced_until ?? undefined}>
          🔇 Silenced, {formatSilencedUntil(alert.silenced_until!)}
        </span>
        <button
          type="button"
          onClick={() => unsilence()}
          disabled={isPending}
          className="rounded px-1.5 py-0.5 text-muted transition-colors hover:bg-bg-secondary hover:text-fg disabled:opacity-50"
        >
          Unsilence
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 text-xs" onClick={stop}>
      <span className="text-muted">Silence:</span>
      {PRESETS.map(p => (
        <button
          key={p.label}
          type="button"
          onClick={() => silence(p.duration)}
          disabled={isPending}
          title={p.title}
          className="rounded px-1.5 py-0.5 text-muted transition-colors hover:bg-bg-secondary hover:text-fg disabled:opacity-50"
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}
