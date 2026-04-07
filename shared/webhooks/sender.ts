import logger = require('../utils/logger');
import type Database from 'better-sqlite3';
import type { Alert, WebhookRow, DigestData, WebhookResult, WebhookDispatchResult } from '../types';

const { getEnabledWebhooks } = require('./queries') as { getEnabledWebhooks: (db: Database.Database, opts?: { onAlert?: boolean; onDigest?: boolean }) => WebhookRow[] };

// --- Alert formatters per type ---

function formatSlackAlert(alert: Alert): { text: string } {
  const emoji = alert.isResolution ? ':white_check_mark:' : ':rotating_light:';
  const label = alert.isResolution ? 'RESOLVED' : alert.reminderNumber > 0 ? `REMINDER #${alert.reminderNumber}` : 'ALERT';
  return { text: `${emoji} *[${label}]* ${alert.message}` };
}

function formatDiscordAlert(alert: Alert): { content: string } {
  const emoji = alert.isResolution ? '\u2705' : '\ud83d\udea8';
  const label = alert.isResolution ? 'RESOLVED' : alert.reminderNumber > 0 ? `REMINDER #${alert.reminderNumber}` : 'ALERT';
  return { content: `${emoji} **[${label}]** ${alert.message}` };
}

function formatTelegramAlert(alert: Alert, chatId: string): Record<string, string> {
  const emoji = alert.isResolution ? '\u2705' : '\ud83d\udea8';
  const label = alert.isResolution ? 'RESOLVED' : alert.reminderNumber > 0 ? `REMINDER #${alert.reminderNumber}` : 'ALERT';
  return {
    chat_id: chatId,
    text: `${emoji} <b>[${label}]</b> ${escapeHtml(alert.message)}\n\nType: ${alert.type}\nTarget: ${alert.target}`,
    parse_mode: 'HTML',
  };
}

function formatNtfyAlert(alert: Alert): { body: string; headers: Record<string, string> } {
  const label = alert.isResolution ? 'RESOLVED' : 'ALERT';
  const priority = alert.isResolution ? 'default' : 'high';
  const tags = alert.isResolution ? 'white_check_mark' : 'warning';
  return {
    body: alert.message,
    headers: {
      'X-Title': `[${label}] insightd`,
      'X-Priority': priority,
      'X-Tags': tags,
    },
  };
}

function formatGenericAlert(alert: Alert): Record<string, unknown> {
  return {
    event: 'alert',
    timestamp: new Date().toISOString(),
    ...alert,
  };
}

// --- Digest formatters per type ---

function formatSlackDigest(digest: DigestData): { text: string } {
  const icon = digest.overallStatus === 'green' ? ':large_green_circle:' : digest.overallStatus === 'yellow' ? ':large_yellow_circle:' : ':red_circle:';
  const lines = [
    `${icon} *Insightd Week ${digest.weekNumber}*: ${digest.summaryLine}`,
    `Uptime: ${digest.overallUptime}% | Restarts: ${digest.totalRestarts} | Hosts: ${digest.hostCount}`,
  ];
  if (digest.diskWarnings && digest.diskWarnings.length > 0) {
    lines.push(`Disk warnings: ${digest.diskWarnings.map(d => d.mount_point).join(', ')}`);
  }
  if (digest.endpoints && digest.endpoints.length > 0) {
    const down = digest.endpoints.filter(e => e.uptimePercent != null && e.uptimePercent < 99);
    if (down.length > 0) lines.push(`Endpoints with downtime: ${down.map(e => e.name).join(', ')}`);
  }
  return { text: lines.join('\n') };
}

function formatDiscordDigest(digest: DigestData): { content: string } {
  const icon = digest.overallStatus === 'green' ? '\ud83d\udfe2' : digest.overallStatus === 'yellow' ? '\ud83d\udfe1' : '\ud83d\udd34';
  return { content: `${icon} **Insightd Week ${digest.weekNumber}**: ${digest.summaryLine}\nUptime: ${digest.overallUptime}% | Restarts: ${digest.totalRestarts}` };
}

function formatTelegramDigest(digest: DigestData, chatId: string): Record<string, string> {
  const icon = digest.overallStatus === 'green' ? '\ud83d\udfe2' : digest.overallStatus === 'yellow' ? '\ud83d\udfe1' : '\ud83d\udd34';
  return {
    chat_id: chatId,
    text: `${icon} <b>Insightd Week ${digest.weekNumber}</b>\n${escapeHtml(digest.summaryLine)}\nUptime: ${digest.overallUptime}% | Restarts: ${digest.totalRestarts}`,
    parse_mode: 'HTML',
  };
}

function formatNtfyDigest(digest: DigestData): { body: string; headers: Record<string, string> } {
  const tags = digest.overallStatus === 'green' ? 'white_check_mark' : digest.overallStatus === 'yellow' ? 'warning' : 'rotating_light';
  return {
    body: `${digest.summaryLine}\nUptime: ${digest.overallUptime}% | Restarts: ${digest.totalRestarts} | Hosts: ${digest.hostCount}`,
    headers: {
      'X-Title': `Insightd Week ${digest.weekNumber}`,
      'X-Priority': 'default',
      'X-Tags': tags,
    },
  };
}

function formatGenericDigest(digest: DigestData): Record<string, unknown> {
  return { event: 'digest', timestamp: new Date().toISOString(), ...digest };
}

// --- Format dispatch ---

type WebhookPayload = Record<string, unknown>;

function formatAlert(type: string, alert: Alert, webhook: WebhookRow): WebhookPayload {
  switch (type) {
    case 'slack': return formatSlackAlert(alert);
    case 'discord': return formatDiscordAlert(alert);
    case 'telegram': return formatTelegramAlert(alert, webhook.secret!);
    case 'ntfy': return formatNtfyAlert(alert) as unknown as WebhookPayload;
    default: return formatGenericAlert(alert);
  }
}

function formatDigest(type: string, digest: DigestData, webhook: WebhookRow): WebhookPayload {
  switch (type) {
    case 'slack': return formatSlackDigest(digest);
    case 'discord': return formatDiscordDigest(digest);
    case 'telegram': return formatTelegramDigest(digest, webhook.secret!);
    case 'ntfy': return formatNtfyDigest(digest) as unknown as WebhookPayload;
    default: return formatGenericDigest(digest);
  }
}

// --- Core sender ---

async function sendWebhook(webhook: WebhookRow, payload: WebhookPayload): Promise<WebhookResult> {
  const url = buildUrl(webhook);
  const isNtfy = webhook.type === 'ntfy';
  const headers: Record<string, string> = {};
  let body: string;

  if (isNtfy) {
    headers['Content-Type'] = 'text/plain';
    Object.assign(headers, (payload as { headers?: Record<string, string> }).headers || {});
    body = (payload as { body?: string }).body || '';
  } else {
    headers['Content-Type'] = 'application/json';
    if (webhook.type === 'generic' && webhook.secret) {
      headers['Authorization'] = webhook.secret;
    }
    body = JSON.stringify(payload);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
    if (!res.ok) {
      logger.warn('webhook', `Webhook "${webhook.name}" returned ${res.status}`);
    }
    return { ok: res.ok, status: res.status };
  } catch (err) {
    logger.error('webhook', `Webhook "${webhook.name}" failed: ${(err as Error).message}`);
    return { ok: false, error: (err as Error).message };
  } finally {
    clearTimeout(timeout);
  }
}

function buildUrl(webhook: WebhookRow): string {
  if (webhook.type === 'telegram') {
    return `https://api.telegram.org/bot${webhook.url}/sendMessage`;
  }
  return webhook.url;
}

// --- Dispatch functions ---

async function dispatchAlertWebhooks(db: Database.Database, alert: Alert): Promise<WebhookDispatchResult[]> {
  const webhooks = getEnabledWebhooks(db, { onAlert: true });
  if (webhooks.length === 0) return [];

  const results: WebhookDispatchResult[] = [];
  for (const wh of webhooks) {
    try {
      const payload = formatAlert(wh.type, alert, wh);
      const result = await sendWebhook(wh, payload);
      results.push({ webhook: wh.name, ...result });
    } catch (err) {
      logger.error('webhook', `Alert dispatch to "${wh.name}" failed: ${(err as Error).message}`);
      results.push({ webhook: wh.name, ok: false, error: (err as Error).message });
    }
  }
  return results;
}

async function dispatchDigestWebhooks(db: Database.Database, digestData: DigestData): Promise<WebhookDispatchResult[]> {
  const webhooks = getEnabledWebhooks(db, { onDigest: true });
  if (webhooks.length === 0) return [];

  const results: WebhookDispatchResult[] = [];
  for (const wh of webhooks) {
    try {
      const payload = formatDigest(wh.type, digestData, wh);
      const result = await sendWebhook(wh, payload);
      results.push({ webhook: wh.name, ...result });
    } catch (err) {
      logger.error('webhook', `Digest dispatch to "${wh.name}" failed: ${(err as Error).message}`);
      results.push({ webhook: wh.name, ok: false, error: (err as Error).message });
    }
  }
  return results;
}

async function sendTestWebhook(webhook: WebhookRow): Promise<WebhookResult> {
  const testAlert: Alert = {
    type: 'test',
    hostId: 'test-host',
    target: 'test-container',
    message: 'This is a test notification from insightd',
    value: 'test',
    reminderNumber: 0,
    isResolution: false,
  };
  const payload = formatAlert(webhook.type, testAlert, webhook);
  return sendWebhook(webhook, payload);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = {
  sendWebhook, buildUrl, sendTestWebhook,
  dispatchAlertWebhooks, dispatchDigestWebhooks,
  formatAlert, formatDigest,
  formatSlackAlert, formatDiscordAlert, formatTelegramAlert, formatNtfyAlert, formatGenericAlert,
  formatSlackDigest, formatDiscordDigest, formatTelegramDigest, formatNtfyDigest, formatGenericDigest,
};
