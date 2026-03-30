const path = require('path');

const config = Object.freeze({
  // Data storage
  dataDir: process.env.INSIGHTD_DATA_DIR || '/data',
  get dbPath() {
    return path.join(this.dataDir, 'insightd.db');
  },

  // Host ID (used in standalone mode)
  hostId: process.env.INSIGHTD_HOST_ID || 'local',

  // MQTT broker (if set, runs in hub mode; if empty, standalone mode)
  mqttUrl: process.env.INSIGHTD_MQTT_URL || '',
  mqttUser: process.env.INSIGHTD_MQTT_USER || '',
  mqttPass: process.env.INSIGHTD_MQTT_PASS || '',

  // Docker (standalone mode only)
  dockerSocket: process.env.DOCKER_HOST || '/var/run/docker.sock',
  hostRoot: process.env.INSIGHTD_HOST_ROOT || '/host',

  // Collection (standalone mode only)
  collectIntervalMinutes: parseInt(process.env.INSIGHTD_COLLECT_INTERVAL || '5', 10),

  // Digest
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

  digestTo: process.env.INSIGHTD_DIGEST_TO || '',

  // Thresholds
  diskWarnPercent: parseInt(process.env.INSIGHTD_DISK_WARN_THRESHOLD || '85', 10),

  // Update checks (standalone mode only)
  updateCheckCron: process.env.INSIGHTD_UPDATE_CHECK_CRON || '0 3 * * *',

  // Web UI
  web: Object.freeze({
    enabled: process.env.INSIGHTD_WEB_ENABLED !== 'false',
    port: parseInt(process.env.INSIGHTD_WEB_PORT || '3000', 10),
    host: process.env.INSIGHTD_WEB_HOST || '0.0.0.0',
  }),

  // Alerts
  alerts: Object.freeze({
    enabled: process.env.INSIGHTD_ALERTS_ENABLED === 'true',
    to: process.env.INSIGHTD_ALERTS_TO || process.env.INSIGHTD_DIGEST_TO || '',
    cooldownMinutes: parseInt(process.env.INSIGHTD_ALERT_COOLDOWN || '60', 10),
    cpuPercent: parseInt(process.env.INSIGHTD_ALERT_CPU || '90', 10),
    memoryMb: parseInt(process.env.INSIGHTD_ALERT_MEMORY || '0', 10),
    diskPercent: parseInt(process.env.INSIGHTD_ALERT_DISK || '90', 10),
    restartCount: parseInt(process.env.INSIGHTD_ALERT_RESTART || '3', 10),
    containerDown: process.env.INSIGHTD_ALERT_DOWN !== 'false',
    hostCpuPercent: parseInt(process.env.INSIGHTD_ALERT_HOST_CPU || '90', 10),
    hostMemoryAvailableMb: parseInt(process.env.INSIGHTD_ALERT_HOST_MEMORY || '0', 10),
    hostLoadThreshold: parseFloat(process.env.INSIGHTD_ALERT_LOAD || '0'),
    containerUnhealthy: process.env.INSIGHTD_ALERT_UNHEALTHY !== 'false',
  }),
});

function validate() {
  const warnings = [];
  if (!config.smtp.host) warnings.push('INSIGHTD_SMTP_HOST not set — email digest disabled');
  if (!config.digestTo) warnings.push('INSIGHTD_DIGEST_TO not set — email digest disabled');
  if (config.alerts.enabled && !config.alerts.to) warnings.push('INSIGHTD_ALERTS_ENABLED is true but no recipient set');
  if (config.alerts.enabled && !config.smtp.host) warnings.push('INSIGHTD_ALERTS_ENABLED is true but SMTP not configured');
  return warnings;
}

module.exports = { config, validate };
