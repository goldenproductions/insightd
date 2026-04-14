import path = require('path');

const config = Object.freeze({
  // Data storage
  dataDir: process.env.INSIGHTD_DATA_DIR || '/data',
  get dbPath(): string {
    return path.join(this.dataDir, 'insightd.db');
  },

  // Host identification
  hostId: process.env.INSIGHTD_HOST_ID || 'local',

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

  // Web (public URL of this hub; used to link from emails back to the UI)
  web: Object.freeze({
    baseUrl: process.env.INSIGHTD_WEB_BASE_URL || '',
  }),

  // Alerts
  alerts: Object.freeze({
    enabled: process.env.INSIGHTD_ALERTS_ENABLED === 'true',
    to: process.env.INSIGHTD_ALERTS_TO || process.env.INSIGHTD_DIGEST_TO || '',
    cooldownMinutes: parseInt(process.env.INSIGHTD_ALERT_COOLDOWN || '60', 10),
    reminderBackoff: process.env.INSIGHTD_ALERT_REMINDER_BACKOFF !== 'false',
    reminderMaxMinutes: parseInt(process.env.INSIGHTD_ALERT_REMINDER_MAX || '1440', 10),
    cpuPercent: parseInt(process.env.INSIGHTD_ALERT_CPU || '90', 10),
    memoryMb: parseInt(process.env.INSIGHTD_ALERT_MEMORY || '0', 10),
    diskPercent: parseInt(process.env.INSIGHTD_ALERT_DISK || '90', 10),
    restartCount: parseInt(process.env.INSIGHTD_ALERT_RESTART || '3', 10),
    containerDown: process.env.INSIGHTD_ALERT_DOWN !== 'false',
  }),
});

function validate(): string[] {
  const warnings: string[] = [];
  if (!config.smtp.host) warnings.push('INSIGHTD_SMTP_HOST not set — email digest disabled');
  if (!config.digestTo) warnings.push('INSIGHTD_DIGEST_TO not set — email digest disabled');
  if (config.alerts.enabled && !config.alerts.to) warnings.push('INSIGHTD_ALERTS_ENABLED is true but no recipient set');
  if (config.alerts.enabled && !config.smtp.host) warnings.push('INSIGHTD_ALERTS_ENABLED is true but SMTP not configured');
  return warnings;
}

module.exports = { config, validate };
