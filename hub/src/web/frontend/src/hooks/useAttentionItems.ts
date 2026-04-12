import { useMemo } from 'react';
import type { DashboardData, Alert } from '@/types/api';
import { fmtDurationMs } from '@/lib/formatters';

export interface AttentionItem {
  kind: 'alert' | 'downtime';
  severity: 'critical' | 'warning';
  title: string;
  detail: string;
  meta: string;
  time: string | null;
  to: string;
}

const HOST_SCOPED_ALERTS = new Set(['disk_full', 'high_host_cpu', 'low_host_memory', 'high_load']);
const ENDPOINT_SCOPED_ALERTS = new Set(['endpoint_down']);

function alertLink(alert: Alert): string {
  if (HOST_SCOPED_ALERTS.has(alert.alert_type)) {
    return `/hosts/${encodeURIComponent(alert.host_id)}`;
  }
  if (ENDPOINT_SCOPED_ALERTS.has(alert.alert_type)) {
    return `/endpoints`;
  }
  return `/hosts/${encodeURIComponent(alert.host_id)}/containers/${encodeURIComponent(alert.target)}`;
}

export function useAttentionItems(data: DashboardData | undefined): AttentionItem[] {
  return useMemo(() => {
    if (!data) return [];
    const items: AttentionItem[] = [];

    for (const alert of data.activeAlertsList) {
      items.push({
        kind: 'alert',
        severity: 'critical',
        title: alert.message || alert.alert_type.replace(/_/g, ' '),
        detail: alert.message ? alert.target : alert.target,
        meta: alert.host_id,
        time: alert.triggered_at,
        to: alertLink(alert),
      });
    }

    for (const c of data.availability.downContainers) {
      const hasAlert = data.activeAlertsList.some(a => a.host_id === c.hostId && a.target === c.name);
      if (hasAlert) continue;
      items.push({
        kind: 'downtime',
        severity: c.uptimePercent < 95 ? 'critical' : 'warning',
        title: `${c.name} down ~${fmtDurationMs(c.downMinutes * 60000)}`,
        detail: `${c.uptimePercent}% uptime`,
        meta: c.hostId,
        time: null,
        to: `/hosts/${encodeURIComponent(c.hostId)}/containers/${encodeURIComponent(c.name)}`,
      });
    }

    // Insights are displayed separately on the dashboard — not mixed into this list

    const sevOrder = { critical: 0, warning: 1 } as const;
    const kindOrder = { alert: 0, downtime: 1 } as const;
    items.sort((a, b) => (sevOrder[a.severity] - sevOrder[b.severity]) || (kindOrder[a.kind] - kindOrder[b.kind]));
    return items;
  }, [data]);
}
