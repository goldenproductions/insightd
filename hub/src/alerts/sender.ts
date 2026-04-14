import type Database from 'better-sqlite3';
const nodemailer = require('nodemailer');
import logger = require('../../../shared/utils/logger');
const { renderAlertHtml, renderAlertText, subjectFor } = require('../../../shared/mail/alert-template');

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

/**
 * Pull the most relevant persisted diagnosis finding for a container alert.
 * Returns null for host/endpoint alerts (diagnosis engine is container-scoped)
 * or when no finding is available. The row is pre-sorted critical→warning in
 * getEntityInsights; we take the first match.
 */
function fetchDiagnosis(db: Database.Database | undefined, alert: AlertItem): any {
  if (!db) return null;
  if (!alert.type || alert.type.startsWith('host_') || alert.type.startsWith('endpoint_')) return null;
  if (!alert.hostId || !alert.target) return null;
  try {
    const { getEntityInsights } = require('../insights/queries');
    const rows = getEntityInsights(db, 'container', `${alert.hostId}/${alert.target}`);
    if (!Array.isArray(rows) || rows.length === 0) return null;
    // Prefer rows from the 'health' category (produced by the diagnosis engine)
    // with populated evidence, falling back to the first row otherwise.
    const withEvidence = rows.find((r: any) => r.category === 'health' && r.evidence);
    return withEvidence || rows[0];
  } catch (err) {
    logger.warn('alert-sender', `Failed to load diagnosis for ${alert.target}: ${(err as Error).message}`);
    return null;
  }
}

async function sendAlert(alert: AlertItem, config: AlertSenderConfig, db?: Database.Database): Promise<void> {
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

  const diagnosis = fetchDiagnosis(db, alert);
  const baseUrl = config.web?.baseUrl || '';
  const ctx = { diagnosis, baseUrl };

  const info = await transporter.sendMail({
    from: config.smtp.from,
    to: config.alerts.to,
    subject: subjectFor(alert),
    text: renderAlertText(alert, ctx),
    html: renderAlertHtml(alert, ctx),
  });

  logger.info('alert-sender', `Alert sent to ${config.alerts.to} (${info.messageId})`);
}

module.exports = { sendAlert };
