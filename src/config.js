const path = require('path');

const config = Object.freeze({
  // Data storage
  dataDir: process.env.INSIGHTD_DATA_DIR || '/data',
  get dbPath() {
    return path.join(this.dataDir, 'insightd.db');
  },

  // Collection
  collectIntervalMinutes: parseInt(process.env.INSIGHTD_COLLECT_INTERVAL || '5', 10),

  // Docker
  dockerSocket: process.env.DOCKER_HOST || '/var/run/docker.sock',

  // Host filesystem (for disk usage when running in container)
  hostRoot: process.env.INSIGHTD_HOST_ROOT || '/host',

  // Digest schedule (cron expression, default: Monday 08:00)
  digestCron: process.env.INSIGHTD_DIGEST_CRON || '0 8 * * 1',
  timezone: process.env.TZ || 'UTC',

  // SMTP
  smtp: Object.freeze({
    host: process.env.INSIGHTD_SMTP_HOST || '',
    port: parseInt(process.env.INSIGHTD_SMTP_PORT || '587', 10),
    user: process.env.INSIGHTD_SMTP_USER || '',
    pass: process.env.INSIGHTD_SMTP_PASS || '',
    from: process.env.INSIGHTD_SMTP_FROM || process.env.INSIGHTD_SMTP_USER || 'insightd@localhost',
  }),

  // Digest recipient
  digestTo: process.env.INSIGHTD_DIGEST_TO || '',

  // Thresholds
  diskWarnPercent: parseInt(process.env.INSIGHTD_DISK_WARN_THRESHOLD || '85', 10),

  // Update checks (daily by default)
  updateCheckCron: process.env.INSIGHTD_UPDATE_CHECK_CRON || '0 3 * * *',
});

function validate() {
  const warnings = [];
  if (!config.smtp.host) warnings.push('INSIGHTD_SMTP_HOST not set — email digest disabled');
  if (!config.digestTo) warnings.push('INSIGHTD_DIGEST_TO not set — email digest disabled');
  return warnings;
}

module.exports = { config, validate };
