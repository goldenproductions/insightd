/**
 * Alert email renderer — HTML + plaintext.
 *
 * Used by both hub/src/alerts/sender.ts and src/alerts/sender.ts (standalone).
 * The sender is responsible for pre-resolving the diagnosis row (if any); this
 * module stays free of DB handles so it can be tested with pure fixtures.
 */

const {
  emailShell,
  hero,
  card,
  metricRow,
  calloutBox,
  evidenceList,
  button,
  badge,
  mutedText,
  linkTo,
  escapeHtml,
} = require('./components');

export interface AlertEmailInput {
  type: string;
  target: string;
  hostId?: string;
  message: string;
  value?: unknown;
  triggeredAt?: string;
  reminderNumber?: number;
  isResolution?: boolean;
}

/**
 * Shape of a row from the `insights` table with v26 diagnosis columns.
 * Matches the INSERT in hub/src/insights/diagnosis/run.ts — evidence is a JSON
 * array of strings.
 */
export interface AlertDiagnosisRow {
  title: string;
  message: string;
  severity: string;
  evidence?: string | null;
  suggested_action?: string | null;
  confidence?: string | null;
  computed_at?: string;
}

export interface RenderAlertContext {
  diagnosis?: AlertDiagnosisRow | null;
  baseUrl?: string;
  /** Full host display name for the hero; defaults to alert.hostId. */
  hostLabel?: string;
}

function resolveSeverity(alert: AlertEmailInput): 'red' | 'yellow' | 'green' {
  if (alert.isResolution) return 'green';
  // Container-down and reminders escalate visually to red.
  if (alert.type.includes('down') || alert.type.includes('unhealthy') || alert.type.includes('crash')) return 'red';
  return 'yellow';
}

function humanType(type: string): string {
  return type
    .replace(/_/g, ' ')
    .replace(/([A-Z])/g, ' $1')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

function parseEvidence(row: AlertDiagnosisRow | null | undefined): string[] {
  if (!row || !row.evidence) return [];
  try {
    const parsed = JSON.parse(row.evidence);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is string => typeof e === 'string').slice(0, 5);
  } catch {
    return [];
  }
}

function linkForAlert(baseUrl: string | undefined, alert: AlertEmailInput): string | undefined {
  if (!baseUrl) return undefined;
  // Container alerts → container detail page. Host/endpoint alerts → their detail pages.
  // Target shape depends on alert type; sender.ts passes hostId separately.
  const host = alert.hostId || '';
  const target = alert.target || '';
  if (alert.type.startsWith('host_')) return linkTo(baseUrl, `/hosts/${encodeURIComponent(host)}`);
  if (alert.type.startsWith('endpoint_')) return linkTo(baseUrl, `/endpoints`);
  // Container types — target is the container name
  if (host && target) return linkTo(baseUrl, `/containers/${encodeURIComponent(host)}/${encodeURIComponent(target)}`);
  return linkTo(baseUrl, '/alerts');
}

function subjectFor(alert: AlertEmailInput): string {
  if (alert.isResolution) return `[OK] insightd: ${alert.message}`;
  if ((alert.reminderNumber ?? 0) > 0) {
    return `[ALERT] insightd: ${alert.message} (reminder #${alert.reminderNumber})`;
  }
  return `[ALERT] insightd: ${alert.message}`;
}

function renderAlertHtml(alert: AlertEmailInput, ctx: RenderAlertContext = {}): string {
  const severity = resolveSeverity(alert);
  const host = ctx.hostLabel || alert.hostId || '';
  const nowIso = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  const eyebrow = alert.isResolution
    ? 'Resolved'
    : (alert.reminderNumber ?? 0) > 0
      ? `Reminder · #${alert.reminderNumber}`
      : 'Alert';

  const subtitleParts: string[] = [];
  if (host) subtitleParts.push(host);
  if (alert.target && alert.target !== host) subtitleParts.push(alert.target);
  const subtitle = subtitleParts.join(' · ') || undefined;

  const heroHtml = hero({
    severity,
    eyebrow,
    title: alert.message,
    subtitle,
    timestamp: alert.isResolution && alert.triggeredAt
      ? `Was alerting since ${alert.triggeredAt} · resolved ${nowIso}`
      : `Triggered ${alert.triggeredAt || nowIso}`,
  });

  const detailRows: string[] = [];
  detailRows.push(metricRow({ label: 'Type', value: humanType(alert.type), last: false }));
  if (host) detailRows.push(metricRow({ label: 'Host', value: host, last: false }));
  if (alert.target && alert.target !== host) {
    detailRows.push(metricRow({ label: 'Target', value: alert.target, last: false }));
  }
  if (alert.value != null && alert.value !== '') {
    detailRows.push(metricRow({ label: 'Value', value: String(alert.value), last: false }));
  }
  if ((alert.reminderNumber ?? 0) > 0) {
    detailRows.push(metricRow({ label: 'Reminder', value: `#${alert.reminderNumber}`, last: true }));
  } else {
    // Mark the last row so the trailing border is suppressed.
    const lastIdx = detailRows.length - 1;
    if (lastIdx >= 0) {
      detailRows[lastIdx] = detailRows[lastIdx].replace('border-bottom:1px solid #e5e7eb;', '');
    }
  }

  const detailCard = card({
    title: 'Details',
    accent: severity,
    attachedToHero: true,
    children: detailRows.join(''),
  });

  // Diagnosis card (v26 engine) — only when data is present and not a resolution.
  const diag = ctx.diagnosis;
  let diagnosisCard = '';
  if (diag && !alert.isResolution) {
    const evidence = parseEvidence(diag);
    const confidenceBadge = diag.confidence
      ? badge({ text: `Confidence: ${diag.confidence}`, tone: 'muted' })
      : '';
    const actionHtml = diag.suggested_action
      ? calloutBox({ tone: severity, children: `<strong>Suggested action.</strong> ${escapeHtml(diag.suggested_action)}` })
      : '';
    const evidenceHtml = evidence.length > 0
      ? `<div style="font-size:12px;font-weight:600;color:#374151;margin-top:6px;letter-spacing:0.3px;text-transform:uppercase;">Top signals</div>${evidenceList(evidence)}`
      : '';
    const title = diag.title ? `<div style="font-size:15px;font-weight:600;color:#111827;margin-bottom:6px;">${escapeHtml(diag.title)}</div>` : '';
    const msg = diag.message ? `<div style="font-size:13px;color:#374151;line-height:1.55;margin-bottom:6px;">${escapeHtml(diag.message)}</div>` : '';

    diagnosisCard = card({
      title: 'Why this is alerting',
      children: `${title}${msg}${actionHtml}${evidenceHtml}${confidenceBadge ? `<div style="margin-top:10px;">${confidenceBadge}</div>` : ''}`,
    });
  }

  const link = linkForAlert(ctx.baseUrl, alert);
  const openButton = link
    ? `<div style="margin-top:4px;">${button({ href: link, text: alert.isResolution ? 'View in Insightd' : 'Open in Insightd', tone: severity })}</div>`
    : '';

  const helpText = alert.isResolution
    ? mutedText('This alert has been resolved. You will not receive further reminders for this incident.')
    : mutedText('Reminders slow down as an alert persists (1h → 2h → 4h → … capped at 24h). Silence or tune in Settings → Alerts.');

  const actionCard = card({
    children: `${openButton}${helpText}`,
  });

  const body = `${heroHtml}${detailCard}${diagnosisCard}${actionCard}`;
  const preheader = alert.isResolution
    ? `Resolved: ${alert.message}`
    : `${humanType(alert.type)} on ${host || alert.target}`;

  return emailShell({
    title: subjectFor(alert),
    body,
    preheader,
  });
}

function renderAlertText(alert: AlertEmailInput, ctx: RenderAlertContext = {}): string {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const lines: string[] = [];

  if (alert.isResolution) {
    lines.push(`RESOLVED: ${alert.message}`);
    lines.push('');
    if (alert.triggeredAt) lines.push(`Was alerting since: ${alert.triggeredAt} UTC`);
    lines.push(`Resolved at:        ${now}`);
  } else {
    lines.push(`ALERT: ${alert.message}`);
    lines.push('');
    lines.push(`Type:      ${humanType(alert.type)}`);
    if (alert.hostId) lines.push(`Host:      ${alert.hostId}`);
    lines.push(`Target:    ${alert.target}`);
    if (alert.value !== undefined && alert.value !== null && alert.value !== '') {
      lines.push(`Value:     ${alert.value}`);
    }
    lines.push(`Time:      ${now}`);
    if ((alert.reminderNumber ?? 0) > 0) lines.push(`Reminder:  #${alert.reminderNumber}`);
  }

  const diag = ctx.diagnosis;
  if (diag && !alert.isResolution) {
    lines.push('');
    lines.push('--- Why this is alerting ---');
    if (diag.title) lines.push(diag.title);
    if (diag.message) lines.push(diag.message);
    if (diag.suggested_action) {
      lines.push('');
      lines.push(`Suggested action: ${diag.suggested_action}`);
    }
    const evidence = parseEvidence(diag);
    if (evidence.length > 0) {
      lines.push('');
      lines.push('Top signals:');
      for (const e of evidence) lines.push(`  • ${e}`);
    }
    if (diag.confidence) {
      lines.push('');
      lines.push(`Confidence: ${diag.confidence}`);
    }
  }

  const link = linkForAlert(ctx.baseUrl, alert);
  if (link) {
    lines.push('');
    lines.push(`Open in Insightd: ${link}`);
  }

  lines.push('');
  lines.push('---');
  if (alert.isResolution) {
    lines.push('Set INSIGHTD_ALERTS_ENABLED=false to disable alerts.');
  } else {
    lines.push('Reminders slow down as the alert persists, up to once per day until resolved.');
    lines.push('Set INSIGHTD_ALERTS_ENABLED=false to disable alerts.');
  }

  return lines.join('\n');
}

module.exports = {
  renderAlertHtml,
  renderAlertText,
  subjectFor,
  humanType,
  parseEvidence,
  linkForAlert,
};
