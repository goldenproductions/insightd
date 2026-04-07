import type Database from 'better-sqlite3';
const nodemailer = require('nodemailer');
const { renderHtml, renderPlainText } = require('./template');
import logger = require('../../../shared/utils/logger');

interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

interface SenderConfig {
  smtp: SmtpConfig;
  digestTo: string;
}

interface DigestData {
  overallStatus: string;
  weekNumber: number;
  summaryLine: string;
  [key: string]: any;
}

async function sendDigest(digestData: DigestData, config: SenderConfig, db: Database.Database | null): Promise<void> {
  // Send email if SMTP is configured
  if (config.smtp.host && config.digestTo) {
    const transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: {
        user: config.smtp.user,
        pass: config.smtp.pass,
      },
    });

    const icon = digestData.overallStatus === 'green' ? '🟢' : digestData.overallStatus === 'yellow' ? '🟡' : '🔴';
    const subject = `${icon} Insightd — Week ${digestData.weekNumber}: ${digestData.summaryLine}`;

    const info = await transporter.sendMail({
      from: config.smtp.from,
      to: config.digestTo,
      subject,
      text: renderPlainText(digestData),
      html: renderHtml(digestData),
    });

    logger.info('sender', `Digest sent to ${config.digestTo} (messageId: ${info.messageId})`);
  } else {
    logger.warn('sender', 'SMTP not configured — skipping email delivery');
  }

  // Dispatch to webhooks
  if (db) {
    try {
      const { dispatchDigestWebhooks } = require('../../../shared/webhooks/sender');
      await dispatchDigestWebhooks(db, digestData);
    } catch (err) {
      logger.error('sender', 'Webhook digest dispatch failed', err);
    }
  }
}

module.exports = { sendDigest };
