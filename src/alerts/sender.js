const nodemailer = require('nodemailer');
const logger = require('../utils/logger');

function formatSubject(alert) {
  if (alert.isResolution) {
    return `[OK] insightd: ${alert.message}`;
  }
  if (alert.reminderNumber > 0) {
    return `[ALERT] insightd: ${alert.message} (reminder #${alert.reminderNumber})`;
  }
  return `[ALERT] insightd: ${alert.message}`;
}

function formatBody(alert) {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const lines = [];

  if (alert.isResolution) {
    lines.push(`RESOLVED: ${alert.message}`);
    lines.push('');
    if (alert.triggeredAt) {
      lines.push(`Was alerting since: ${alert.triggeredAt} UTC`);
    }
    lines.push(`Resolved at:        ${now}`);
  } else {
    lines.push(`ALERT: ${alert.message}`);
    lines.push('');
    lines.push(`Type:      ${alert.type}`);
    lines.push(`Target:    ${alert.target}`);
    if (alert.value !== undefined) {
      lines.push(`Value:     ${alert.value}`);
    }
    lines.push(`Time:      ${now}`);
    if (alert.reminderNumber > 0) {
      lines.push(`Reminder:  #${alert.reminderNumber}`);
    }
  }

  lines.push('');
  lines.push('---');
  lines.push('This alert will repeat every cooldown period until resolved.');
  lines.push('Set INSIGHTD_ALERTS_ENABLED=false to disable alerts.');

  return lines.join('\n');
}

async function sendAlert(alert, config) {
  if (!config.smtp.host || !config.alerts.to) {
    logger.warn('alert-sender', 'SMTP not configured — skipping alert');
    return;
  }

  const transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: {
      user: config.smtp.user,
      pass: config.smtp.pass,
    },
  });

  const info = await transporter.sendMail({
    from: config.smtp.from,
    to: config.alerts.to,
    subject: formatSubject(alert),
    text: formatBody(alert),
  });

  logger.info('alert-sender', `Alert sent to ${config.alerts.to} (${info.messageId})`);
}

module.exports = { sendAlert, formatSubject, formatBody };
