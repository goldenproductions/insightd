const logger = require('../utils/logger');
const { getEnabledWebhooks } = require('./queries');

// --- Alert formatters per type ---

function formatSlackAlert(alert) {
  const emoji = alert.isResolution ? ':white_check_mark:' : ':rotating_light:';
  const label = alert.isResolution ? 'RESOLVED' : alert.reminderNumber > 0 ? `REMINDER #${alert.reminderNumber}` : 'ALERT';
  return { text: `${emoji} *[${label}]* ${alert.message}` };
}

function formatDiscordAlert(alert) {
  const emoji = alert.isResolution ? '\u2705' : '\ud83d\udea8';
  const label = alert.isResolution ? 'RESOLVED' : alert.reminderNumber > 0 ? `REMINDER #${alert.reminderNumber}` : 'ALERT';
  return { content: `${emoji} **[${label}]** ${alert.message}` };
}

function formatTelegramAlert(alert, chatId) {
  const emoji = alert.isResolution ? '\u2705' : '\ud83d\udea8';
  const label = alert.isResolution ? 'RESOLVED' : alert.reminderNumber > 0 ? `REMINDER #${alert.reminderNumber}` : 'ALERT';
  return {
    chat_id: chatId,
    text: `${emoji} <b>[${label}]</b> ${escapeHtml(alert.message)}\n\nType: ${alert.type}\nTarget: ${alert.target}`,
    parse_mode: 'HTML',
  };
}

function formatNtfyAlert(alert) {
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

function formatGenericAlert(alert) {
  return {
    event: 'alert',
    timestamp: new Date().toISOString(),
    ...alert,
  };
}

// --- Digest formatters per type ---

function formatSlackDigest(digest) {
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

function formatDiscordDigest(digest) {
  const icon = digest.overallStatus === 'green' ? '\ud83d\udfe2' : digest.overallStatus === 'yellow' ? '\ud83d\udfe1' : '\ud83d\udd34';
  return { content: `${icon} **Insightd Week ${digest.weekNumber}**: ${digest.summaryLine}\nUptime: ${digest.overallUptime}% | Restarts: ${digest.totalRestarts}` };
}

function formatTelegramDigest(digest, chatId) {
  const icon = digest.overallStatus === 'green' ? '\ud83d\udfe2' : digest.overallStatus === 'yellow' ? '\ud83d\udfe1' : '\ud83d\udd34';
  return {
    chat_id: chatId,
    text: `${icon} <b>Insightd Week ${digest.weekNumber}</b>\n${escapeHtml(digest.summaryLine)}\nUptime: ${digest.overallUptime}% | Restarts: ${digest.totalRestarts}`,
    parse_mode: 'HTML',
  };
}

function formatNtfyDigest(digest) {
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

function formatGenericDigest(digest) {
  return { event: 'digest', timestamp: new Date().toISOString(), ...digest };
}

// --- Format dispatch ---

function formatAlert(type, alert, webhook) {
  switch (type) {
    case 'slack': return formatSlackAlert(alert);
    case 'discord': return formatDiscordAlert(alert);
    case 'telegram': return formatTelegramAlert(alert, webhook.secret);
    case 'ntfy': return formatNtfyAlert(alert);
    default: return formatGenericAlert(alert);
  }
}

function formatDigest(type, digest, webhook) {
  switch (type) {
    case 'slack': return formatSlackDigest(digest);
    case 'discord': return formatDiscordDigest(digest);
    case 'telegram': return formatTelegramDigest(digest, webhook.secret);
    case 'ntfy': return formatNtfyDigest(digest);
    default: return formatGenericDigest(digest);
  }
}

// --- Core sender ---

async function sendWebhook(webhook, payload) {
  const url = buildUrl(webhook);
  const isNtfy = webhook.type === 'ntfy';
  const headers = {};
  let body;

  if (isNtfy) {
    headers['Content-Type'] = 'text/plain';
    Object.assign(headers, payload.headers || {});
    body = payload.body || '';
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
    logger.error('webhook', `Webhook "${webhook.name}" failed: ${err.message}`);
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timeout);
  }
}

function buildUrl(webhook) {
  if (webhook.type === 'telegram') {
    return `https://api.telegram.org/bot${webhook.url}/sendMessage`;
  }
  return webhook.url;
}

// --- Dispatch functions ---

async function dispatchAlertWebhooks(db, alert) {
  const webhooks = getEnabledWebhooks(db, { onAlert: true });
  if (webhooks.length === 0) return [];

  const results = [];
  for (const wh of webhooks) {
    try {
      const payload = formatAlert(wh.type, alert, wh);
      const result = await sendWebhook(wh, payload);
      results.push({ webhook: wh.name, ...result });
    } catch (err) {
      logger.error('webhook', `Alert dispatch to "${wh.name}" failed: ${err.message}`);
      results.push({ webhook: wh.name, ok: false, error: err.message });
    }
  }
  return results;
}

async function dispatchDigestWebhooks(db, digestData) {
  const webhooks = getEnabledWebhooks(db, { onDigest: true });
  if (webhooks.length === 0) return [];

  const results = [];
  for (const wh of webhooks) {
    try {
      const payload = formatDigest(wh.type, digestData, wh);
      const result = await sendWebhook(wh, payload);
      results.push({ webhook: wh.name, ...result });
    } catch (err) {
      logger.error('webhook', `Digest dispatch to "${wh.name}" failed: ${err.message}`);
      results.push({ webhook: wh.name, ok: false, error: err.message });
    }
  }
  return results;
}

async function sendTestWebhook(webhook) {
  const testAlert = {
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

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = {
  sendWebhook, buildUrl, sendTestWebhook,
  dispatchAlertWebhooks, dispatchDigestWebhooks,
  formatAlert, formatDigest,
  formatSlackAlert, formatDiscordAlert, formatTelegramAlert, formatNtfyAlert, formatGenericAlert,
  formatSlackDigest, formatDiscordDigest, formatTelegramDigest, formatNtfyDigest, formatGenericDigest,
};
