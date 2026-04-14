/**
 * Weekly digest email renderer — HTML + plaintext.
 *
 * Used by both hub/src/digest/template.ts and src/digest/template.ts (via a
 * thin shim that forwards DigestData). This module is pure-function: no DB,
 * no filesystem, no env vars — everything comes through DigestData.
 */

const {
  emailShell,
  hero,
  card,
  metricRow,
  mutedText,
  button,
  linkTo,
  escapeHtml,
} = require('./components');

type Severity = 'red' | 'yellow' | 'green' | 'muted';

export interface DigestData {
  weekNumber: number;
  generatedAt: string;
  overallStatus: string;
  summaryLine: string;
  overallUptime: number;
  totalRestarts: number;
  restartedContainers: string[];
  containers: Array<{ name: string; hostId?: string; status: string; uptimePercent: number; restarts: number }>;
  endpoints?: Array<{ name: string; uptimePercent: number | null; avgResponseMs: number | null }>;
  trends: Array<{ name: string; cpuChange: number | null; ramChange: number | null }>;
  disk: Array<{ host_id?: string; mount_point: string; total_gb: number; used_gb: number; used_percent: number }>;
  diskWarnings: Array<{ mount_point: string; used_percent: number }>;
  updatesAvailable: Array<{ container_name: string; image: string }>;
  hostMetrics?: Array<{
    hostId: string;
    avgCpu: number | null;
    maxCpu: number | null;
    avgMemUsedMb: number | null;
    maxMemUsedMb: number | null;
    memTotalMb: number | null;
    avgLoad: number | null;
    maxLoad: number | null;
  }>;
  triggeredAlertsThisWeek?: Array<{
    type: string;
    target: string;
    hostId: string;
    message: string;
    triggeredAt: string;
    resolvedAt: string | null;
    durationMinutes: number;
    reminderCount: number;
  }>;
  anomaliesThisWeek?: Array<{
    entityType: string;
    entityId: string;
    metric: string;
    bucketStart: string;
    robustZ: number;
  }>;
  hostGroups?: Array<{ group: string | null; hostIds: string[] }>;
}

function severityFromStatus(s: string): Severity {
  if (s === 'red') return 'red';
  if (s === 'yellow') return 'yellow';
  if (s === 'green') return 'green';
  return 'muted';
}

function formatDuration(minutes: number): string {
  if (minutes < 1) return '<1 min';
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 60 * 24) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(minutes / (60 * 24));
  const h = Math.floor((minutes % (60 * 24)) / 60);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

function formatMetricLabel(metric: string): string {
  return metric.replace(/_/g, ' ').replace(/\bcpu\b/i, 'CPU').replace(/\bmem\b/i, 'memory');
}

function heroAnalogy(digest: DigestData): { eyebrow: string; title: string; subtitle: string } {
  const alerts = digest.triggeredAlertsThisWeek?.length ?? 0;
  const issues = digest.summaryLine;
  const eyebrow = `Week ${digest.weekNumber} · ${digest.hostGroups && digest.hostGroups.length > 0 ? `${digest.hostGroups.reduce((n, g) => n + g.hostIds.length, 0)} hosts` : 'Your fleet'}`;
  if (digest.overallStatus === 'green' && alerts === 0) {
    return { eyebrow, title: 'A calm week', subtitle: `Nothing needed attention. ${digest.overallUptime}% overall uptime.` };
  }
  if (digest.overallStatus === 'yellow') {
    return { eyebrow, title: 'A few things to look at', subtitle: issues };
  }
  return { eyebrow, title: 'Things needed attention', subtitle: issues };
}

function renderNeedsAttention(digest: DigestData, baseUrl?: string): string {
  const alerts = digest.triggeredAlertsThisWeek ?? [];
  if (alerts.length === 0) return '';
  const top = alerts.slice(0, 5);
  const rows = top.map((a, i) => {
    const sev: Severity = a.resolvedAt ? 'muted' : 'red';
    const duration = formatDuration(a.durationMinutes);
    const sublabel = `${a.hostId ? `${a.hostId} · ` : ''}${a.resolvedAt ? `resolved after ${duration}` : `active for ${duration}`}${a.reminderCount > 0 ? ` · ${a.reminderCount} reminders` : ''}`;
    const href = baseUrl && a.hostId && a.target
      ? linkTo(baseUrl, `/containers/${encodeURIComponent(a.hostId)}/${encodeURIComponent(a.target)}`)
      : undefined;
    return metricRow({
      label: a.message,
      value: duration,
      status: sev,
      sublabel,
      href,
      last: i === top.length - 1,
    });
  }).join('');
  const moreHtml = alerts.length > 5
    ? `<div style="margin-top:10px;">${mutedText(`+${alerts.length - 5} more this week`)}</div>`
    : '';
  return card({
    title: 'Needs attention',
    accent: 'red',
    children: rows + moreHtml,
  });
}

function renderHostsSection(digest: DigestData): string {
  if (!digest.hostMetrics || digest.hostMetrics.length === 0) return '';
  const groups = digest.hostGroups ?? [];
  const multipleGroups = groups.filter(g => g.group).length > 0 && groups.length > 1;
  const metricsByHost = new Map(digest.hostMetrics.map(h => [h.hostId, h]));
  const renderHostRow = (hostId: string, isLast: boolean): string => {
    const h = metricsByHost.get(hostId);
    if (!h) return '';
    const memPct = h.memTotalMb && h.avgMemUsedMb ? Math.round((h.avgMemUsedMb / h.memTotalMb) * 100) : null;
    const valueParts: string[] = [];
    valueParts.push(`CPU ${h.avgCpu ?? '—'}% (peak ${h.maxCpu ?? '—'}%)`);
    if (memPct !== null) valueParts.push(`RAM ${memPct}%`);
    if (h.avgLoad !== null) valueParts.push(`Load ${h.avgLoad}`);
    const cpuVal = h.maxCpu ?? 0;
    const memVal = memPct ?? 0;
    const status: Severity = cpuVal > 80 || memVal > 85 ? 'red' : cpuVal > 60 || memVal > 70 ? 'yellow' : 'green';
    return metricRow({
      label: hostId,
      value: valueParts.join(' · '),
      status,
      last: isLast,
    });
  };

  let body: string;
  if (multipleGroups) {
    const chunks: string[] = [];
    for (const g of groups) {
      const label = g.group || 'Ungrouped';
      chunks.push(`<div style="font-size:11px;font-weight:700;color:#6b7280;letter-spacing:0.8px;text-transform:uppercase;padding:10px 0 4px 0;">${escapeHtml(label)}</div>`);
      g.hostIds.forEach((hid, i) => {
        chunks.push(renderHostRow(hid, i === g.hostIds.length - 1));
      });
    }
    body = chunks.join('');
  } else {
    body = digest.hostMetrics.map((h, i) => renderHostRow(h.hostId, i === digest.hostMetrics!.length - 1)).join('');
  }

  return card({ title: 'Host system', children: body });
}

function renderContainers(digest: DigestData): string {
  if (digest.containers.length === 0) return '';
  const rows = digest.containers.map((c, i) => metricRow({
    label: c.name,
    value: `${c.uptimePercent}% uptime${c.restarts > 0 ? ` · ${c.restarts} restart${c.restarts > 1 ? 's' : ''}` : ''}`,
    status: severityFromStatus(c.status),
    last: i === digest.containers.length - 1,
  })).join('');
  return card({ title: 'Containers', children: rows });
}

function renderEndpoints(digest: DigestData): string {
  if (!digest.endpoints || digest.endpoints.length === 0) return '';
  const rows = digest.endpoints.map((ep, i) => {
    const uptime = ep.uptimePercent != null ? `${ep.uptimePercent}%` : 'No data';
    const avgMs = ep.avgResponseMs != null ? `${ep.avgResponseMs}ms` : '—';
    const status: Severity = ep.uptimePercent == null ? 'muted'
      : ep.uptimePercent >= 99 ? 'green'
      : ep.uptimePercent >= 90 ? 'yellow'
      : 'red';
    return metricRow({
      label: ep.name,
      value: `${uptime} uptime · ${avgMs} avg`,
      status,
      last: i === digest.endpoints!.length - 1,
    });
  }).join('');
  return card({ title: 'Endpoint uptime', children: rows });
}

function renderInsights(digest: DigestData): string {
  const anomalies = digest.anomaliesThisWeek ?? [];
  const trends = digest.trends;
  if (anomalies.length === 0 && trends.length === 0) return '';
  const anomalyRows = anomalies.slice(0, 5).map((a, i) => metricRow({
    label: a.entityId,
    value: `${formatMetricLabel(a.metric)} · z=${a.robustZ.toFixed(1)}`,
    sublabel: `bucket ${a.bucketStart}`,
    status: Math.abs(a.robustZ) >= 10 ? 'red' : 'yellow',
    last: i === Math.min(5, anomalies.length) - 1 && trends.length === 0,
  })).join('');
  const trendRows = trends.map((t, i) => {
    const parts: string[] = [];
    const arrow = (v: number): string => v > 0 ? '↑' : v < 0 ? '↓' : '→';
    if (t.ramChange !== null) parts.push(`RAM ${arrow(t.ramChange)} ${Math.abs(t.ramChange)}%`);
    if (t.cpuChange !== null) parts.push(`CPU ${arrow(t.cpuChange)} ${Math.abs(t.cpuChange)}%`);
    return metricRow({
      label: t.name,
      value: parts.join(' · '),
      status: 'yellow',
      last: i === trends.length - 1,
    });
  }).join('');
  const heading = anomalies.length > 0
    ? `<div style="font-size:11px;font-weight:700;color:#6b7280;letter-spacing:0.8px;text-transform:uppercase;padding:0 0 6px 0;">Anomalies detected</div>`
    : '';
  const trendHeading = trends.length > 0
    ? `<div style="font-size:11px;font-weight:700;color:#6b7280;letter-spacing:0.8px;text-transform:uppercase;padding:${anomalies.length > 0 ? '14' : '0'}px 0 6px 0;">Resource trends</div>`
    : '';
  return card({
    title: 'Insights',
    children: `${heading}${anomalyRows}${trendHeading}${trendRows}`,
  });
}

function renderDisk(digest: DigestData): string {
  if (digest.disk.length === 0) return '';
  const rows = digest.disk.map((d, i) => {
    const warn = d.used_percent >= 85;
    const status: Severity = d.used_percent >= 90 ? 'red' : d.used_percent >= 85 ? 'yellow' : 'green';
    return metricRow({
      label: d.mount_point,
      value: `${d.used_gb}/${d.total_gb} GB (${d.used_percent}%)${warn ? ' ⚠' : ''}`,
      status,
      last: i === digest.disk.length - 1,
    });
  }).join('');
  return card({ title: 'Disk usage', children: rows });
}

function renderUpdates(digest: DigestData): string {
  if (digest.updatesAvailable.length === 0) return '';
  const rows = digest.updatesAvailable.map((u, i) => metricRow({
    label: u.container_name,
    value: u.image,
    last: i === digest.updatesAvailable.length - 1,
  })).join('');
  return card({ title: `Updates available (${digest.updatesAvailable.length})`, children: rows });
}

function renderActionCard(digest: DigestData, baseUrl?: string): string {
  const openBtn = baseUrl ? button({ href: linkTo(baseUrl, '/') || baseUrl, text: 'Open Insightd dashboard' }) : '';
  const generated = `Generated ${new Date(digest.generatedAt).toLocaleString()}`;
  return card({
    children: `${openBtn}<div style="margin-top:${openBtn ? '4' : '0'}px;">${mutedText(generated)}</div>`,
  });
}

function renderHtml(digest: DigestData, baseUrl?: string): string {
  const sev = severityFromStatus(digest.overallStatus);
  const a = heroAnalogy(digest);

  const heroHtml = hero({
    severity: sev,
    eyebrow: a.eyebrow,
    title: a.title,
    subtitle: a.subtitle,
  });

  // Summary strip attached to the hero
  const summaryParts: string[] = [];
  summaryParts.push(metricRow({ label: 'Overall uptime', value: `${digest.overallUptime}%`, last: false }));
  summaryParts.push(metricRow({ label: 'Restarts', value: String(digest.totalRestarts), sublabel: digest.restartedContainers.length > 0 ? digest.restartedContainers.join(', ') : undefined, last: false }));
  summaryParts.push(metricRow({ label: 'Updates available', value: String(digest.updatesAvailable.length), last: !digest.diskWarnings.length }));
  if (digest.diskWarnings.length > 0) {
    summaryParts.push(metricRow({
      label: 'Disk warnings',
      value: digest.diskWarnings.map(w => `${w.mount_point} ${w.used_percent}%`).join(', '),
      status: 'yellow',
      last: true,
    }));
  }
  const summaryCard = card({ attachedToHero: true, children: summaryParts.join('') });

  const sections = [
    summaryCard,
    renderNeedsAttention(digest, baseUrl),
    renderHostsSection(digest),
    renderContainers(digest),
    renderEndpoints(digest),
    renderInsights(digest),
    renderDisk(digest),
    renderUpdates(digest),
    renderActionCard(digest, baseUrl),
  ].filter(s => s.length > 0);

  const body = heroHtml + sections.join('');
  const preheader = `Week ${digest.weekNumber} · ${digest.summaryLine}`;

  return emailShell({
    title: `Insightd · Week ${digest.weekNumber}`,
    body,
    preheader,
  });
}

function renderPlainText(digest: DigestData, baseUrl?: string): string {
  const lines: string[] = [];
  lines.push(`Insightd · Week ${digest.weekNumber}`);
  lines.push('');
  lines.push(digest.summaryLine);
  lines.push('');
  lines.push(`Overall uptime: ${digest.overallUptime}%`);
  lines.push(`Restarts:       ${digest.totalRestarts}${digest.restartedContainers.length > 0 ? ` (${digest.restartedContainers.join(', ')})` : ''}`);
  lines.push(`Updates:        ${digest.updatesAvailable.length}`);

  const alerts = digest.triggeredAlertsThisWeek ?? [];
  if (alerts.length > 0) {
    lines.push('');
    lines.push('--- Needs attention ---');
    for (const a of alerts.slice(0, 5)) {
      const dur = formatDuration(a.durationMinutes);
      const state = a.resolvedAt ? `resolved after ${dur}` : `active for ${dur}`;
      lines.push(`  • [${a.hostId}] ${a.message} (${state})`);
    }
    if (alerts.length > 5) lines.push(`  +${alerts.length - 5} more`);
  }

  if (digest.hostMetrics && digest.hostMetrics.length > 0) {
    lines.push('');
    lines.push('--- Host system ---');
    for (const h of digest.hostMetrics) {
      const memPct = h.memTotalMb && h.avgMemUsedMb ? Math.round((h.avgMemUsedMb / h.memTotalMb) * 100) : null;
      lines.push(`  ${h.hostId}: CPU avg ${h.avgCpu ?? '?'}% (peak ${h.maxCpu ?? '?'}%)${memPct !== null ? ` · RAM ${memPct}%` : ''} · Load ${h.avgLoad ?? '?'}`);
    }
  }

  if (digest.trends.length > 0) {
    lines.push('');
    lines.push('--- Resource trends ---');
    for (const t of digest.trends) {
      const parts: string[] = [];
      if (t.ramChange) parts.push(`${Math.abs(t.ramChange)}% ${t.ramChange > 0 ? 'more' : 'less'} RAM`);
      if (t.cpuChange) parts.push(`${Math.abs(t.cpuChange)}% ${t.cpuChange > 0 ? 'more' : 'less'} CPU`);
      lines.push(`  ${t.name}: ${parts.join(', ')}`);
    }
  }

  const anomalies = digest.anomaliesThisWeek ?? [];
  if (anomalies.length > 0) {
    lines.push('');
    lines.push('--- Anomalies detected ---');
    for (const a of anomalies.slice(0, 5)) {
      lines.push(`  ${a.entityId} · ${formatMetricLabel(a.metric)} · z=${a.robustZ.toFixed(1)}`);
    }
  }

  if (digest.endpoints && digest.endpoints.length > 0) {
    lines.push('');
    lines.push('--- Endpoints ---');
    for (const ep of digest.endpoints) {
      const uptime = ep.uptimePercent != null ? `${ep.uptimePercent}%` : 'No data';
      const avgMs = ep.avgResponseMs != null ? `${ep.avgResponseMs}ms avg` : '';
      lines.push(`  ${ep.name}: ${uptime} uptime${avgMs ? ` · ${avgMs}` : ''}`);
    }
  }

  if (digest.diskWarnings.length > 0) {
    lines.push('');
    lines.push(`Disk warnings: ${digest.diskWarnings.map(w => `${w.mount_point} at ${w.used_percent}%`).join(', ')}`);
  }

  if (baseUrl) {
    lines.push('');
    lines.push(`Open dashboard: ${baseUrl}`);
  }

  return lines.join('\n');
}

module.exports = { renderHtml, renderPlainText };
