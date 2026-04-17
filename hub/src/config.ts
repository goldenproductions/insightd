import path = require('path');

const VERSION: string = process.env.INSIGHTD_VERSION || '0.3.0';

const config = Object.freeze({
  // Data storage
  dataDir: process.env.INSIGHTD_DATA_DIR || '/data',
  get dbPath(): string {
    return path.join(this.dataDir, 'insightd.db');
  },

  // Host ID (used in standalone mode)
  hostId: process.env.INSIGHTD_HOST_ID || 'local',

  // MQTT broker (if set, runs in hub mode; if empty, standalone mode)
  mqttUrl: process.env.INSIGHTD_MQTT_URL || '',
  mqttUser: process.env.INSIGHTD_MQTT_USER || '',
  mqttPass: process.env.INSIGHTD_MQTT_PASS || '',

  // External hostname (for agent setup command generation)
  externalHost: process.env.INSIGHTD_EXTERNAL_HOST || '',

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

  // Log tailing
  logLines: parseInt(process.env.INSIGHTD_LOG_LINES || '100', 10),
  logTimeoutMs: parseInt(process.env.INSIGHTD_LOG_TIMEOUT || '15000', 10),

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
    hostCpuPercent: parseInt(process.env.INSIGHTD_ALERT_HOST_CPU || '90', 10),
    hostMemoryAvailableMb: parseInt(process.env.INSIGHTD_ALERT_HOST_MEMORY || '0', 10),
    hostLoadThreshold: parseFloat(process.env.INSIGHTD_ALERT_LOAD || '0'),
    hostOffline: process.env.INSIGHTD_ALERT_HOST_OFFLINE !== 'false',
    hostOfflineMinutes: parseInt(process.env.INSIGHTD_ALERT_HOST_OFFLINE_MINUTES || '15', 10),
    containerUnhealthy: process.env.INSIGHTD_ALERT_UNHEALTHY !== 'false',
    excludeContainers: process.env.INSIGHTD_ALERT_EXCLUDE || '',
    endpointDown: process.env.INSIGHTD_ALERT_ENDPOINT_DOWN !== 'false',
    endpointFailureThreshold: parseInt(process.env.INSIGHTD_ALERT_ENDPOINT_FAILURES || '3', 10),
  }),

  // AI diagnosis (Gemini)
  ai: Object.freeze({
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    get enabled(): boolean {
      return !!this.geminiApiKey;
    },
    requestTimeoutMs: parseInt(process.env.GEMINI_TIMEOUT_MS || '20000', 10),
    cacheMaxAgeMs: parseInt(process.env.GEMINI_CACHE_MAX_AGE_MS || String(24 * 60 * 60 * 1000), 10),
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

// Number of consecutive missed collection cycles before a host (and its
// container/disk data) is considered stale/offline. A host is offline when
// last_seen is older than OFFLINE_CYCLES × collectIntervalMinutes.
const OFFLINE_CYCLES = 3;

function offlineThresholdMinutes(): number {
  return config.collectIntervalMinutes * OFFLINE_CYCLES;
}

module.exports = { config, validate, VERSION, OFFLINE_CYCLES, offlineThresholdMinutes };
