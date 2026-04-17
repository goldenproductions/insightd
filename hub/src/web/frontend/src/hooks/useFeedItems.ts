import { useMemo } from 'react';
import type { DashboardData, Alert, DashboardInsight } from '@/types/api';
import type { FeedSeverity } from '@/components/FeedRow';
import { formatAlertType, timeAgo } from '@/lib/formatters';
import { splitContainerEntityId } from '@/lib/containers';

export interface FeedItem {
  id: string;
  kind: 'alert' | 'insight';
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
    const split = splitContainerEntityId(insight.entity_id);
    if (split) {
      return `/hosts/${encodeURIComponent(split.hostId)}/containers/${encodeURIComponent(split.containerName)}`;
    }
  }
  return `/hosts/${encodeURIComponent(insight.entity_id)}`;
}

function insightEntityName(insight: DashboardInsight): string {
  if (insight.entity_type === 'container') {
    const split = splitContainerEntityId(insight.entity_id);
    if (split) return split.containerName;
  }
  return insight.entity_id;
}

function normalizeInsightSeverity(sev: string): FeedSeverity | null {
  if (sev === 'critical') return 'critical';
  if (sev === 'warning') return 'warning';
  return null;
}

const SEVERITY_ORDER: Record<FeedSeverity, number> = { critical: 0, warning: 1, info: 2 };
const KIND_ORDER: Record<FeedItem['kind'], number> = { alert: 0, insight: 1 };

interface AvailabilityEvidence {
  lastDownAt?: string;
  downMinutes?: number;
  uptimePct?: number;
}

function parseAvailabilityEvidence(raw: string | null | undefined): AvailabilityEvidence | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AvailabilityEvidence;
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed;
  } catch { return null; }
}

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
        title: alert.message || formatAlertType(alert.alert_type),
        pillLabel: 'Alert',
        detail: alert.target,
        meta: alert.host_id,
        time: alert.triggered_at,
        to: alertLink(alert),
      });
    }

    // Retrospective "had downtime" events used to produce a separate acute
    // "Downtime" row here, duplicating the `availability` insight from
    // topInsights. That made recovered dips look like active problems.
    // They now live only in the Insights feed below, with a timeAgo-rich
    // detail so the user can tell "3h ago" from "23h ago" at a glance.

    for (const insight of data.topInsights ?? []) {
      const severity = normalizeInsightSeverity(insight.severity);
      if (!severity) continue;
      const config = INSIGHT_CONFIG[insight.category] ?? INSIGHT_CONFIG.performance!;

      let detail = insight.message;
      if (insight.category === 'availability') {
        const ev = parseAvailabilityEvidence(insight.evidence);
        if (ev?.lastDownAt) {
          const pct = typeof ev.uptimePct === 'number' ? `${ev.uptimePct}% uptime` : null;
          const ago = timeAgo(ev.lastDownAt);
          detail = pct ? `Brief dip ${ago} — ${pct}` : `Brief dip ${ago}`;
        }
      }

      items.push({
        id: `insight-${insight.entity_type}-${insight.entity_id}-${insight.category}`,
        kind: 'insight',
        severity,
        icon: config.icon,
        title: insight.title,
        pillLabel: config.label,
        detail,
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
