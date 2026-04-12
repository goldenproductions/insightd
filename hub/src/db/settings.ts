import type Database from 'better-sqlite3';

/**
 * Settings resolution layer.
 * Reads from SQLite settings table, merges with env var defaults.
 * DB values override env vars for supported keys.
 */

interface SettingDef {
  key: string;
  env: string;
  type: 'string' | 'int' | 'float' | 'bool';
  category: string;
  label: string;
  hotReload: boolean;
  default: string;
  sensitive?: boolean;
  description?: string;
}

interface SettingResult {
  key: string;
  value: string;
  source: string;
  type: string;
  category: string;
  label: string;
  hotReload: boolean;
  sensitive: boolean;
  description: string | null;
}

interface DbSettingRow {
  key: string;
  value: string;
  updated_at?: string;
}

interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

interface AlertsConfig {
  enabled: boolean;
  to: string;
  cooldownMinutes: number;
  cpuPercent: number;
  memoryMb: number;
  diskPercent: number;
  restartCount: number;
  containerDown: boolean;
  hostCpuPercent: number;
  hostMemoryAvailableMb: number;
  hostLoadThreshold: number;
  containerUnhealthy: boolean;
  excludeContainers: string;
  endpointDown: boolean;
  endpointFailureThreshold: number;
}

interface AiConfig {
  geminiApiKey: string;
  geminiModel: string;
  requestTimeoutMs: number;
  cacheMaxAgeMs: number;
  enabled?: boolean;
}

interface BaseConfig {
  digestTo: string;
  diskWarnPercent: number;
  smtp: SmtpConfig;
  alerts: AlertsConfig;
  ai?: AiConfig;
  [key: string]: any;
}

const SETTING_DEFS: SettingDef[] = [
  // Email/SMTP
  { key: 'smtp.host', env: 'INSIGHTD_SMTP_HOST', type: 'string', category: 'Email', label: 'SMTP Host', hotReload: true, default: '' },
  { key: 'smtp.port', env: 'INSIGHTD_SMTP_PORT', type: 'int', category: 'Email', label: 'SMTP Port', hotReload: true, default: '587' },
  { key: 'smtp.user', env: 'INSIGHTD_SMTP_USER', type: 'string', category: 'Email', label: 'SMTP User', hotReload: true, default: '' },
  { key: 'smtp.pass', env: 'INSIGHTD_SMTP_PASS', type: 'string', category: 'Email', label: 'SMTP Password', hotReload: true, default: '', sensitive: true },
  { key: 'smtp.from', env: 'INSIGHTD_SMTP_FROM', type: 'string', category: 'Email', label: 'From Address', hotReload: true, default: '' },

  // Digest
  { key: 'digestTo', env: 'INSIGHTD_DIGEST_TO', type: 'string', category: 'Digest', label: 'Digest Recipient', hotReload: true, default: '' },
  { key: 'digestCron', env: 'INSIGHTD_DIGEST_CRON', type: 'string', category: 'Digest', label: 'Digest Schedule (cron)', hotReload: false, default: '0 8 * * 1' },

  // Alerts
  { key: 'alerts.enabled', env: 'INSIGHTD_ALERTS_ENABLED', type: 'bool', category: 'Alerts', label: 'Alerts Enabled', hotReload: true, default: 'false' },
  { key: 'alerts.to', env: 'INSIGHTD_ALERTS_TO', type: 'string', category: 'Alerts', label: 'Alert Recipient', hotReload: true, default: '' },
  { key: 'alerts.cooldownMinutes', env: 'INSIGHTD_ALERT_COOLDOWN', type: 'int', category: 'Alerts', label: 'Cooldown (minutes)', hotReload: true, default: '60' },
  { key: 'alerts.cpuPercent', env: 'INSIGHTD_ALERT_CPU', type: 'int', category: 'Alerts', label: 'Container CPU Threshold (%)', hotReload: true, default: '90' },
  { key: 'alerts.memoryMb', env: 'INSIGHTD_ALERT_MEMORY', type: 'int', category: 'Alerts', label: 'Container Memory Threshold (MB)', hotReload: true, default: '0' },
  { key: 'alerts.diskPercent', env: 'INSIGHTD_ALERT_DISK', type: 'int', category: 'Alerts', label: 'Disk Threshold (%)', hotReload: true, default: '90' },
  { key: 'alerts.restartCount', env: 'INSIGHTD_ALERT_RESTART', type: 'int', category: 'Alerts', label: 'Restart Loop Threshold', hotReload: true, default: '3' },
  { key: 'alerts.containerDown', env: 'INSIGHTD_ALERT_DOWN', type: 'bool', category: 'Alerts', label: 'Container Down Alerts', hotReload: true, default: 'true' },
  { key: 'alerts.hostCpuPercent', env: 'INSIGHTD_ALERT_HOST_CPU', type: 'int', category: 'Alerts', label: 'Host CPU Threshold (%)', hotReload: true, default: '90' },
  { key: 'alerts.hostMemoryAvailableMb', env: 'INSIGHTD_ALERT_HOST_MEMORY', type: 'int', category: 'Alerts', label: 'Host Low Memory Threshold (MB)', hotReload: true, default: '0' },
  { key: 'alerts.hostLoadThreshold', env: 'INSIGHTD_ALERT_LOAD', type: 'float', category: 'Alerts', label: 'Host Load Threshold', hotReload: true, default: '0' },
  { key: 'alerts.containerUnhealthy', env: 'INSIGHTD_ALERT_UNHEALTHY', type: 'bool', category: 'Alerts', label: 'Unhealthy Container Alerts', hotReload: true, default: 'true' },
  { key: 'alerts.excludeContainers', env: 'INSIGHTD_ALERT_EXCLUDE', type: 'string', category: 'Alerts', label: 'Exclude Containers (patterns)', hotReload: true, default: '', description: 'Comma-separated patterns. Use * as wildcard. E.g. dev-*,test-*,insightd-*' },
  { key: 'alerts.endpointDown', env: 'INSIGHTD_ALERT_ENDPOINT_DOWN', type: 'bool', category: 'Alerts', label: 'Endpoint Down Alerts', hotReload: true, default: 'true' },
  { key: 'alerts.endpointFailureThreshold', env: 'INSIGHTD_ALERT_ENDPOINT_FAILURES', type: 'int', category: 'Alerts', label: 'Endpoint Failure Threshold', hotReload: true, default: '3', description: 'Consecutive failures before alerting' },

  // Collection
  { key: 'collectIntervalMinutes', env: 'INSIGHTD_COLLECT_INTERVAL', type: 'int', category: 'Collection', label: 'Collection Interval (minutes)', hotReload: false, default: '5' },
  { key: 'diskWarnPercent', env: 'INSIGHTD_DISK_WARN_THRESHOLD', type: 'int', category: 'Collection', label: 'Disk Warning Threshold (%)', hotReload: true, default: '85' },

  // Storage
  { key: 'retention.rawDays', env: 'INSIGHTD_RETENTION_RAW_DAYS', type: 'int', category: 'Storage', label: 'Raw data retention (days)', hotReload: true, default: '30', description: 'How long to keep full-resolution snapshots (min 7)' },
  { key: 'retention.rollupDays', env: 'INSIGHTD_RETENTION_ROLLUP_DAYS', type: 'int', category: 'Storage', label: 'Rollup data retention (days)', hotReload: true, default: '365', description: 'How long to keep hourly summaries (min 30)' },

  // General
  { key: 'timezone', env: 'TZ', type: 'string', category: 'General', label: 'Timezone', hotReload: false, default: 'UTC' },

  // Status Page
  { key: 'statusPage.enabled', env: 'INSIGHTD_STATUS_PAGE', type: 'bool', category: 'Status Page', label: 'Enable public status page', hotReload: true, default: 'false', description: 'Serve a public status page at /status (no login required)' },
  { key: 'statusPage.title', env: 'INSIGHTD_STATUS_PAGE_TITLE', type: 'string', category: 'Status Page', label: 'Page title', hotReload: true, default: 'System Status', description: 'Title shown on the public status page' },

  // AI Diagnosis
  { key: 'ai.geminiApiKey', env: 'GEMINI_API_KEY', type: 'string', category: 'AI Diagnosis', label: 'Gemini API Key', hotReload: true, default: '', sensitive: true, description: 'Enables the "Diagnose with AI" button on container detail. Get a free key at https://aistudio.google.com/apikey' },
  { key: 'ai.geminiModel', env: 'GEMINI_MODEL', type: 'string', category: 'AI Diagnosis', label: 'Gemini Model', hotReload: true, default: 'gemini-2.0-flash', description: 'Model to use (default: gemini-2.0-flash — free tier, fast)' },
  { key: 'ai.requestTimeoutMs', env: 'GEMINI_TIMEOUT_MS', type: 'int', category: 'AI Diagnosis', label: 'Request Timeout (ms)', hotReload: true, default: '20000', description: 'Abort Gemini request after this many milliseconds' },
];

function getSettings(db: Database.Database): SettingResult[] {
  const dbRows: Record<string, { value: string; updatedAt: string }> = {};
  const rows = db.prepare('SELECT key, value, updated_at FROM settings').all() as DbSettingRow[];
  for (const r of rows) dbRows[r.key] = { value: r.value, updatedAt: r.updated_at! };

  return SETTING_DEFS.map(def => {
    const dbVal = dbRows[def.key];
    const envVal = process.env[def.env];
    let value: string, source: string;

    if (dbVal) {
      value = dbVal.value;
      source = 'db';
    } else if (envVal !== undefined && envVal !== '') {
      value = envVal;
      source = 'env';
    } else {
      value = def.default;
      source = 'default';
    }

    return {
      key: def.key,
      value: def.sensitive ? (value ? '****' : '') : value,
      source,
      type: def.type,
      category: def.category,
      label: def.label,
      hotReload: def.hotReload,
      sensitive: !!def.sensitive,
      description: def.description || null,
    };
  });
}

function putSettings(db: Database.Database, entries: Record<string, string>): { saved: boolean; restartRequired: boolean } {
  const validKeys = new Set(SETTING_DEFS.map(d => d.key));
  const upsert = db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
  );
  let restartRequired = false;

  const save = db.transaction((items: Record<string, string>) => {
    for (const [key, value] of Object.entries(items)) {
      if (!validKeys.has(key)) continue;
      const def = SETTING_DEFS.find(d => d.key === key);
      if (!def) continue;
      if (def.sensitive && value === '****') continue;
      upsert.run(key, String(value));
      if (!def.hotReload) restartRequired = true;
    }
  });

  save(entries);
  return { saved: true, restartRequired };
}

function resolveValue(def: SettingDef, dbRows: Record<string, { value: string }>): string | number | boolean {
  const dbVal = dbRows[def.key];
  const envVal = process.env[def.env];
  const raw = dbVal ? dbVal.value : (envVal !== undefined && envVal !== '' ? envVal : def.default);

  switch (def.type) {
    case 'int': return parseInt(raw, 10) || 0;
    case 'float': return parseFloat(raw) || 0;
    case 'bool': return raw === 'true';
    default: return raw;
  }
}

function getEffectiveConfig(db: Database.Database, baseConfig: BaseConfig): BaseConfig {
  const dbRows: Record<string, { value: string }> = {};
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  for (const r of rows) dbRows[r.key] = { value: r.value };

  const get = (key: string): any => {
    const def = SETTING_DEFS.find(d => d.key === key);
    return def ? resolveValue(def, dbRows) : undefined;
  };

  // ai.geminiApiKey: DB wins, then env (via resolveValue's env lookup), then baseConfig (programmatic).
  // resolveValue already reads env — it only returns '' when both DB and env are empty, so we
  // fall back to baseConfig.ai.geminiApiKey for that case (used by tests/embedded configs).
  const aiApiKeyResolved = get('ai.geminiApiKey') as string;
  const aiApiKey = aiApiKeyResolved || baseConfig.ai?.geminiApiKey || '';
  const aiModel = (get('ai.geminiModel') as string) || baseConfig.ai?.geminiModel || 'gemini-2.0-flash';
  const aiTimeout = (get('ai.requestTimeoutMs') as number) || baseConfig.ai?.requestTimeoutMs || 20000;

  return {
    ...baseConfig,
    ai: {
      ...(baseConfig.ai || {}),
      geminiApiKey: aiApiKey,
      geminiModel: aiModel,
      requestTimeoutMs: aiTimeout,
      cacheMaxAgeMs: baseConfig.ai?.cacheMaxAgeMs ?? 24 * 60 * 60 * 1000,
      enabled: !!aiApiKey,
    },
    retention: {
      rawDays: Math.max(7, get('retention.rawDays') || 30),
      rollupDays: Math.max(30, get('retention.rollupDays') || 365),
    },
    digestTo: get('digestTo') || baseConfig.digestTo,
    diskWarnPercent: get('diskWarnPercent') || baseConfig.diskWarnPercent,
    smtp: {
      ...baseConfig.smtp,
      host: get('smtp.host') || baseConfig.smtp.host,
      port: get('smtp.port') || baseConfig.smtp.port,
      user: get('smtp.user') || baseConfig.smtp.user,
      pass: get('smtp.pass') || baseConfig.smtp.pass,
      from: get('smtp.from') || baseConfig.smtp.from,
    },
    alerts: {
      ...baseConfig.alerts,
      enabled: get('alerts.enabled'),
      to: get('alerts.to') || baseConfig.alerts.to,
      cooldownMinutes: get('alerts.cooldownMinutes') || baseConfig.alerts.cooldownMinutes,
      cpuPercent: get('alerts.cpuPercent'),
      memoryMb: get('alerts.memoryMb'),
      diskPercent: get('alerts.diskPercent'),
      restartCount: get('alerts.restartCount'),
      containerDown: get('alerts.containerDown'),
      hostCpuPercent: get('alerts.hostCpuPercent'),
      hostMemoryAvailableMb: get('alerts.hostMemoryAvailableMb'),
      hostLoadThreshold: get('alerts.hostLoadThreshold'),
      containerUnhealthy: get('alerts.containerUnhealthy'),
      excludeContainers: get('alerts.excludeContainers') || baseConfig.alerts.excludeContainers,
      endpointDown: get('alerts.endpointDown'),
      endpointFailureThreshold: get('alerts.endpointFailureThreshold') || baseConfig.alerts.endpointFailureThreshold,
    },
  };
}

module.exports = { SETTING_DEFS, getSettings, putSettings, getEffectiveConfig };
