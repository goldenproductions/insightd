import type Database from 'better-sqlite3';
const nodemailer = require('nodemailer');
import logger = require('../utils/logger');
const { renderAlertHtml, renderAlertText, subjectFor } = require('../../shared/mail/alert-template');
const { aftermathSubject, renderAftermathText, renderAftermathHtml } = require('../../shared/mail/aftermath-template');

interface AlertItem {
  isResolution?: boolean;
  reminderNumber?: number;
  message: string;
  type: string;
  target: string;
  hostId?: string;
  value?: any;
  triggeredAt?: string;
}

interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

interface AlertSenderConfig {
  smtp: SmtpConfig;
  alerts: {
    to: string;
    [key: string]: any;
  };
  web?: {
    baseUrl?: string;
  };
}

async function sendAlert(alert: AlertItem, config: AlertSenderConfig, _db?: Database.Database): Promise<void> {
  if (!config.smtp.host || !config.alerts.to) {
    logger.warn('alert-sender', 'SMTP not configured \u2014 skipping alert');
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

  const baseUrl = config.web?.baseUrl || '';
  let muteToken: string | undefined;
  try {
    const { signMuteToken } = require('./mute-token');
    muteToken = signMuteToken(alert.type);
  } catch { /* mute-token module unavailable — footer hidden */ }
  // Standalone mode does not run the diagnosis engine — diagnosis is always null here.
  const ctx = { diagnosis: null, baseUrl, muteToken };

  const info = await transporter.sendMail({
    from: config.smtp.from,
    to: config.alerts.to,
    subject: subjectFor(alert),
    text: renderAlertText(alert, ctx),
    html: renderAlertHtml(alert, ctx),
  });

  logger.info('alert-sender', `Alert sent to ${config.alerts.to} (${info.messageId})`);
}

async function sendAftermath(summary: any, config: any): Promise<void> {
  if (!config.smtp.host || !config.alerts.to) return;
  const transporter = nodemailer.createTransport({
    host: config.smtp.host, port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
  });
  const baseUrl = config.web?.baseUrl || '';
  await transporter.sendMail({
    from: config.smtp.from,
    to: config.alerts.to,
    subject: aftermathSubject(summary),
    text: renderAftermathText(summary, baseUrl),
    html: renderAftermathHtml(summary, baseUrl),
  });
}

module.exports = { sendAlert, sendAftermath };
