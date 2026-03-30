const nodemailer = require('nodemailer');
const { renderHtml, renderPlainText } = require('./template');
const logger = require('../utils/logger');

async function sendDigest(digestData, config) {
  if (!config.smtp.host || !config.digestTo) {
    logger.warn('sender', 'SMTP not configured — skipping email delivery');
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
}

module.exports = { sendDigest };
