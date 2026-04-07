const VERSION = process.env.INSIGHTD_VERSION || '0.3.0';

const config = Object.freeze({
  // Host identification (required)
  hostId: process.env.INSIGHTD_HOST_ID || 'local',

  // MQTT broker
  mqttUrl: process.env.INSIGHTD_MQTT_URL || '',
  mqttUser: process.env.INSIGHTD_MQTT_USER || '',
  mqttPass: process.env.INSIGHTD_MQTT_PASS || '',

  // Docker
  dockerSocket: process.env.DOCKER_HOST || '/var/run/docker.sock',

  // Host filesystem
  hostRoot: process.env.INSIGHTD_HOST_ROOT || '/host',

  // Collection interval
  collectIntervalMinutes: parseInt(process.env.INSIGHTD_COLLECT_INTERVAL || '5', 10),

  // Update check schedule
  updateCheckCron: process.env.INSIGHTD_UPDATE_CHECK_CRON || '0 3 * * *',

  // Timezone
  timezone: process.env.TZ || 'UTC',

  // Updates
  allowUpdates: process.env.INSIGHTD_ALLOW_UPDATES === 'true',

  // Container actions (start/stop/restart)
  allowActions: process.env.INSIGHTD_ALLOW_ACTIONS === 'true',

  // Disk warn threshold (used for logging only on agent side)
  diskWarnPercent: parseInt(process.env.INSIGHTD_DISK_WARN_THRESHOLD || '85', 10),

  // Log tailing
  logLines: parseInt(process.env.INSIGHTD_LOG_LINES || '100', 10),
  logMaxLines: parseInt(process.env.INSIGHTD_LOG_MAX_LINES || '1000', 10),
});

function validate(): string[] {
  const errors: string[] = [];
  if (!config.mqttUrl) errors.push('INSIGHTD_MQTT_URL is required');
  if (!config.hostId || config.hostId === 'local') {
    errors.push('INSIGHTD_HOST_ID should be set to identify this host (e.g., "proxmox-01")');
  }
  return errors;
}

module.exports = { config, validate, VERSION };
