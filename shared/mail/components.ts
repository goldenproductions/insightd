/**
 * Email-safe inline-styled HTML primitives shared by alert and digest mail templates.
 *
 * Email clients reject <style> blocks, web fonts, flexbox, and most CSS selectors.
 * Everything here uses inline `style=""`, system font stacks, and <table> layout so
 * Gmail/Outlook/Apple Mail render consistently.
 */

export type Severity = 'red' | 'yellow' | 'green' | 'muted';

export interface EmailShellOptions {
  title: string;
  body: string;
  preheader?: string;
  footerHtml?: string;
}

export interface HeroOptions {
  severity: Severity;
  eyebrow?: string;
  title: string;
  subtitle?: string;
  timestamp?: string;
}

export interface CardOptions {
  title?: string;
  accent?: Severity;
  children: string;
  /** First card drops top corner radius (hero sits above) and skips top margin. */
  attachedToHero?: boolean;
}

export interface MetricRowOptions {
  label: string;
  value: string;
  status?: Severity;
  sublabel?: string;
  href?: string;
  last?: boolean;
}

export interface BadgeOptions {
  text: string;
  tone?: Severity;
}

export interface ButtonOptions {
  href: string;
  text: string;
  tone?: Severity;
}

const COLORS = {
  red: '#dc2626',
  redBg: '#fef2f2',
  yellow: '#d97706',
  yellowBg: '#fffbeb',
  green: '#059669',
  greenBg: '#ecfdf5',
  muted: '#6b7280',
  mutedBg: '#f9fafb',
  text: '#111827',
  subtext: '#374151',
  dim: '#6b7280',
  border: '#e5e7eb',
  pageBg: '#f3f4f6',
  cardBg: '#ffffff',
} as const;

const FONT_STACK = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

function severityColor(sev: Severity): string {
  if (sev === 'red') return COLORS.red;
  if (sev === 'yellow') return COLORS.yellow;
  if (sev === 'green') return COLORS.green;
  return COLORS.muted;
}

function severityBg(sev: Severity): string {
  if (sev === 'red') return COLORS.redBg;
  if (sev === 'yellow') return COLORS.yellowBg;
  if (sev === 'green') return COLORS.greenBg;
  return COLORS.mutedBg;
}

function escapeHtml(raw: string | number | null | undefined): string {
  if (raw == null) return '';
  return String(raw)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function linkTo(baseUrl: string | undefined | null, path: string): string | undefined {
  if (!baseUrl) return undefined;
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

function defaultFooter(): string {
  return `<tr><td style="padding:20px 4px 4px 4px;text-align:center;font-size:12px;color:${COLORS.dim};font-family:${FONT_STACK};">
Sent by <strong style="color:${COLORS.subtext};">Insightd</strong> · self-hosted server awareness
</td></tr>`;
}

function emailShell({ title, body, preheader, footerHtml }: EmailShellOptions): string {
  const preheaderHtml = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;visibility:hidden;mso-hide:all;">${escapeHtml(preheader)}</div>`
    : '';
  const footer = footerHtml ?? defaultFooter();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:${COLORS.pageBg};font-family:${FONT_STACK};color:${COLORS.text};-webkit-font-smoothing:antialiased;">
${preheaderHtml}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COLORS.pageBg};">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;width:100%;">
        ${body}
        ${footer}
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

function hero({ severity, eyebrow, title, subtitle, timestamp }: HeroOptions): string {
  const bg = severityColor(severity);
  const eyebrowHtml = eyebrow
    ? `<div style="font-size:12px;letter-spacing:1.5px;text-transform:uppercase;opacity:0.85;margin-bottom:6px;font-family:${FONT_STACK};">${escapeHtml(eyebrow)}</div>`
    : '';
  const subtitleHtml = subtitle
    ? `<div style="font-size:15px;line-height:1.5;opacity:0.95;margin-top:6px;font-family:${FONT_STACK};">${escapeHtml(subtitle)}</div>`
    : '';
  const timestampHtml = timestamp
    ? `<div style="font-size:12px;opacity:0.75;margin-top:10px;font-family:${FONT_STACK};">${escapeHtml(timestamp)}</div>`
    : '';
  return `<tr><td style="background:${bg};color:#ffffff;padding:28px 28px 24px 28px;border-radius:12px 12px 0 0;font-family:${FONT_STACK};">
${eyebrowHtml}
<div style="font-size:22px;font-weight:700;line-height:1.25;font-family:${FONT_STACK};">${escapeHtml(title)}</div>
${subtitleHtml}
${timestampHtml}
</td></tr>`;
}

function card({ title, accent, children, attachedToHero }: CardOptions): string {
  const accentBar = accent
    ? `<div style="height:3px;background:${severityColor(accent)};"></div>`
    : '';
  const titleHtml = title
    ? `<div style="font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${COLORS.subtext};padding:18px 24px 6px 24px;font-family:${FONT_STACK};">${escapeHtml(title)}</div>`
    : '';
  const radius = attachedToHero ? '0 0 12px 12px' : '12px';
  const spacing = attachedToHero ? '0' : '12px';
  const innerTop = title ? '4' : '18';
  return `<tr><td style="padding:${spacing} 0 0 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COLORS.cardBg};border-radius:${radius};overflow:hidden;border:1px solid ${COLORS.border};">
  <tr><td style="padding:0;">${accentBar}${titleHtml}
<div style="padding:${innerTop}px 24px 18px 24px;font-family:${FONT_STACK};">${children}</div>
</td></tr>
</table>
</td></tr>`;
}

function metricRow({ label, value, status, sublabel, href, last }: MetricRowOptions): string {
  const dot = status
    ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${severityColor(status)};margin-right:8px;vertical-align:middle;"></span>`
    : '';
  const labelHtml = href
    ? `<a href="${escapeHtml(href)}" style="color:${COLORS.text};text-decoration:none;">${escapeHtml(label)}</a>`
    : escapeHtml(label);
  const subHtml = sublabel
    ? `<div style="font-size:12px;color:${COLORS.dim};margin-top:2px;font-family:${FONT_STACK};">${escapeHtml(sublabel)}</div>`
    : '';
  const borderStyle = last ? '' : `border-bottom:1px solid ${COLORS.border};`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="${borderStyle}"><tr>
<td style="padding:10px 0;font-size:14px;color:${COLORS.text};font-family:${FONT_STACK};">${dot}${labelHtml}${subHtml}</td>
<td align="right" style="padding:10px 0;font-size:14px;font-weight:600;color:${COLORS.text};white-space:nowrap;font-family:${FONT_STACK};">${escapeHtml(value)}</td>
</tr></table>`;
}

function badge({ text, tone }: BadgeOptions): string {
  const color = tone ? severityColor(tone) : COLORS.muted;
  const bg = tone ? severityBg(tone) : COLORS.mutedBg;
  return `<span style="display:inline-block;padding:3px 9px;border-radius:999px;font-size:11px;font-weight:600;color:${color};background:${bg};border:1px solid ${color};letter-spacing:0.3px;font-family:${FONT_STACK};">${escapeHtml(text)}</span>`;
}

function button({ href, text, tone }: ButtonOptions): string {
  const bg = tone ? severityColor(tone) : COLORS.subtext;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:10px 0 2px 0;"><tr>
<td style="background:${bg};border-radius:8px;">
<a href="${escapeHtml(href)}" style="display:inline-block;padding:11px 22px;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;font-family:${FONT_STACK};">${escapeHtml(text)}</a>
</td></tr></table>`;
}

function divider(): string {
  return `<div style="height:1px;background:${COLORS.border};margin:8px 0;"></div>`;
}

function mutedText(text: string): string {
  return `<div style="font-size:13px;color:${COLORS.dim};line-height:1.5;font-family:${FONT_STACK};">${escapeHtml(text)}</div>`;
}

function calloutBox({ children, tone }: { children: string; tone: Severity }): string {
  return `<div style="background:${severityBg(tone)};border-left:3px solid ${severityColor(tone)};padding:12px 14px;border-radius:4px;margin:4px 0 10px 0;font-size:13px;color:${COLORS.subtext};line-height:1.55;font-family:${FONT_STACK};">${children}</div>`;
}

function evidenceList(items: string[]): string {
  if (items.length === 0) return '';
  const lis = items
    .map(
      (item) =>
        `<li style="padding:3px 0;color:${COLORS.subtext};font-size:13px;line-height:1.5;font-family:${FONT_STACK};">${escapeHtml(item)}</li>`,
    )
    .join('');
  return `<ul style="margin:6px 0 4px 0;padding:0 0 0 18px;list-style:disc;">${lis}</ul>`;
}

function progressBar({ percent, tone }: { percent: number; tone: Severity }): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const fillColor = severityColor(tone);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0;"><tr><td style="background:${COLORS.border};border-radius:999px;height:6px;font-size:0;line-height:0;"><div style="width:${clamped}%;max-width:100%;background:${fillColor};height:6px;border-radius:999px;font-size:0;line-height:0;">&nbsp;</div></td></tr></table>`;
}

module.exports = {
  colors: COLORS,
  escapeHtml,
  linkTo,
  emailShell,
  hero,
  card,
  metricRow,
  badge,
  button,
  divider,
  mutedText,
  calloutBox,
  evidenceList,
  progressBar,
};
