import { useMemo } from 'react';
import type { DashboardData } from '@/types/api';
import { fmtDurationMs } from '@/lib/formatters';

export interface AttentionItem {
  kind: 'alert' | 'downtime' | 'insight';
  severity: 'critical' | 'warning';
  title: string;
  detail: string;
  meta: string;
  time: string | null;
  to: string;
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
        to: `/hosts/${encodeURIComponent(alert.host_id)}/containers/${encodeURIComponent(alert.target)}`,
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

    for (const insight of data.topInsights) {
      if (insight.severity === 'info') continue;
      const parts = insight.entity_id.split('/');
      items.push({
        kind: 'insight',
        severity: insight.severity as 'critical' | 'warning',
        title: insight.title,
        detail: insight.message,
        meta: insight.entity_id,
        time: null,
        to: insight.entity_type === 'container' && parts.length === 2
          ? `/hosts/${encodeURIComponent(parts[0]!)}/containers/${encodeURIComponent(parts[1]!)}`
          : `/hosts/${encodeURIComponent(insight.entity_id)}`,
      });
    }

    const sevOrder = { critical: 0, warning: 1 } as const;
    const kindOrder = { alert: 0, downtime: 1, insight: 2 } as const;
    items.sort((a, b) => (sevOrder[a.severity] - sevOrder[b.severity]) || (kindOrder[a.kind] - kindOrder[b.kind]));
    return items;
  }, [data]);
}
