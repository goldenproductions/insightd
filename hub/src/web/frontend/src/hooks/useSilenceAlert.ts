import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiAuth } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { queryKeys } from '@/lib/queryKeys';
import type { Alert } from '@/types/api';

export type SilenceDuration = number | 'resolved';

/**
 * Mutation hook to silence or unsilence an alert.
 *
 * - `silence(duration)` — POST /api/alerts/:id/silence with a preset duration
 *   (minutes) or the literal string "resolved" for the until-resolved sentinel.
 * - `unsilence()` — DELETE /api/alerts/:id/silence.
 *
 * Both invalidate `alerts()` and `container()` query keys so the alerts page
 * and the container detail page re-render without needing a manual refetch.
 */
export function useSilenceAlert(alertId: number, hostId?: string, containerName?: string) {
  const { token } = useAuth();
  const queryClient = useQueryClient();

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.alerts() });
    // Dashboard's activeAlertsList + activeAlerts count both filter out
    // silenced alerts (queries.ts), so silencing must invalidate the
    // dashboard query too — otherwise the row sticks around until the
    // 30s refetch tick.
    queryClient.invalidateQueries({ queryKey: queryKeys.dashboard() });
    // Host alerts tab reads `data.alerts` from getHostDetail (queryKeys.host).
    // Without this invalidation, silencing from the host page leaves rows
    // showing preset buttons (stale silenced_until) — the user clicks again,
    // hits the API again, and the page feels unresponsive. AlertsPage
    // experiences the same issue for hostless silences but that path
    // already invalidates queryKeys.alerts() which it subscribes to.
    if (hostId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.host(hostId) });
    }
    if (hostId && containerName) {
      queryClient.invalidateQueries({ queryKey: queryKeys.container(hostId, containerName) });
    }
  };

  const silence = useMutation({
    mutationFn: (duration: SilenceDuration) =>
      apiAuth<Alert>('POST', `/alerts/${alertId}/silence`, { durationMinutes: duration }, token),
    onSuccess: invalidate,
  });

  const unsilence = useMutation({
    mutationFn: () => apiAuth<Alert>('DELETE', `/alerts/${alertId}/silence`, undefined, token),
    onSuccess: invalidate,
  });

  return {
    silence: silence.mutate,
    unsilence: unsilence.mutate,
    isPending: silence.isPending || unsilence.isPending,
    error: silence.error || unsilence.error,
  };
}
