import { useMemo } from 'react';
import type { DashboardData, Alert, DashboardInsight } from '@/types/api';
import type { FeedSeverity } from '@/components/FeedRow';
import { fmtDurationMs } from '@/lib/formatters';

export interface FeedItem {
  id: string;
  kind: 'alert' | 'downtime' | 'insight';
  severity: FeedSeverity;
  icon: string;
  title: string;
  pillLabel: string;
  detail?: string;
  meta: string;
  time?: string | null;
  to: string;
  insight?: DashboardInsight;
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

const INSIGHT_CONFIG: Record<string, { icon: string; label: string }> = {
  prediction: { icon: '\ud83d\udd2e', label: 'Prediction' },
  performance: { icon: '\u26a1', label: 'Performance' },
  trend: { icon: '\ud83d\udcc8', label: 'Trend' },
  availability: { icon: '\u23f0', label: 'Availability' },
  health: { icon: '\ud83e\ude7a', label: 'Health' },
};

function insightLink(insight: DashboardInsight): string {
  if (insight.entity_type === 'container') {
    const parts = insight.entity_id.split('/');
    if (parts.length === 2) {
      return `/hosts/${encodeURIComponent(parts[0]!)}/containers/${encodeURIComponent(parts[1]!)}`;
    }
  }
  return `/hosts/${encodeURIComponent(insight.entity_id)}`;
}

function insightEntityName(insight: DashboardInsight): string {
  if (insight.entity_type === 'container') {
    const parts = insight.entity_id.split('/');
    return parts.length === 2 ? parts[1]! : insight.entity_id;
  }
  return insight.entity_id;
}

function normalizeInsightSeverity(sev: string): FeedSeverity | null {
  if (sev === 'critical') return 'critical';
  if (sev === 'warning') return 'warning';
  return null;
}

const SEVERITY_ORDER: Record<FeedSeverity, number> = { critical: 0, warning: 1, info: 2 };
const KIND_ORDER: Record<FeedItem['kind'], number> = { alert: 0, downtime: 1, insight: 2 };

export function useFeedItems(data: DashboardData | undefined): FeedItem[] {
  return useMemo(() => {
    if (!data) return [];
    const items: FeedItem[] = [];

    for (const alert of data.activeAlertsList) {
      items.push({
        id: `alert-${alert.host_id}-${alert.target}-${alert.alert_type}`,
        kind: 'alert',
        severity: 'critical',
        icon: '\ud83d\udd14',
        title: alert.message || alert.alert_type.replace(/_/g, ' '),
        pillLabel: 'Alert',
        detail: alert.target,
        meta: alert.host_id,
        time: alert.triggered_at,
        to: alertLink(alert),
      });
    }

    for (const c of data.availability.downContainers) {
      const hasAlert = data.activeAlertsList.some(a => a.host_id === c.hostId && a.target === c.name);
      if (hasAlert) continue;
      items.push({
        id: `downtime-${c.hostId}-${c.name}`,
        kind: 'downtime',
        severity: c.uptimePercent < 95 ? 'critical' : 'warning',
        icon: '\u23f8\ufe0f',
        title: `${c.name} down ~${fmtDurationMs(c.downMinutes * 60000)}`,
        pillLabel: 'Downtime',
        detail: `${c.uptimePercent}% uptime`,
        meta: c.hostId,
        to: `/hosts/${encodeURIComponent(c.hostId)}/containers/${encodeURIComponent(c.name)}`,
      });
    }

    for (const insight of data.topInsights ?? []) {
      const severity = normalizeInsightSeverity(insight.severity);
      if (!severity) continue;
      const config = INSIGHT_CONFIG[insight.category] ?? INSIGHT_CONFIG.performance!;
      items.push({
        id: `insight-${insight.entity_type}-${insight.entity_id}-${insight.category}`,
        kind: 'insight',
        severity,
        icon: config.icon,
        title: insight.title,
        pillLabel: config.label,
        detail: insight.message,
        meta: insightEntityName(insight),
        to: insightLink(insight),
        insight,
      });
    }

    items.sort((a, b) =>
      (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) ||
      (KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
    );
    return items;
  }, [data]);
}
