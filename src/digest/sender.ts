import type Database from 'better-sqlite3';
const nodemailer = require('nodemailer');
const { renderHtml, renderPlainText } = require('./template');
import logger = require('../utils/logger');

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

    const icon = digestData.overallStatus === 'green' ? '\u{1F7E2}' : digestData.overallStatus === 'yellow' ? '\u{1F7E1}' : '\u{1F534}';
    const subject = `${icon} Insightd \u2014 Week ${digestData.weekNumber}: ${digestData.summaryLine}`;

    const info = await transporter.sendMail({
      from: config.smtp.from,
      to: config.digestTo,
      subject,
      text: renderPlainText(digestData),
      html: renderHtml(digestData),
    });

    logger.info('sender', `Digest sent to ${config.digestTo} (messageId: ${info.messageId})`);
  } else {
    logger.warn('sender', 'SMTP not configured \u2014 skipping email delivery');
  }

  // Dispatch to webhooks
  if (db) {
    try {
      const { dispatchDigestWebhooks } = require('../../shared/webhooks/sender');
      await dispatchDigestWebhooks(db, digestData);
    } catch (err) {
      logger.error('sender', 'Webhook digest dispatch failed', err);
    }
  }
}

module.exports = { sendDigest };
