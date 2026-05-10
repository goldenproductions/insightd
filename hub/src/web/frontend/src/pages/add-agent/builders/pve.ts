export interface PveCommandInputs {
  identifier: string;
  broker: { url: string; user?: string; pass?: string };
  permissions: { allowUpdates: boolean; allowActions: boolean };
  advanced: {
    collectInterval?: string;
    updateCheckCron?: string;
    tz?: string;
    diskWarnThreshold?: string;
    logLines?: string;
    logMaxLines?: string;
    image?: string;
  };
}

export function buildPveInstallCommand(i: PveCommandInputs): string {
  const { identifier, broker, permissions: p, advanced: a } = i;
  const envs: string[] = [
    `INSIGHTD_HOST_ID=${identifier}`,
    `INSIGHTD_MQTT_URL=${broker.url}`,
  ];
  if (broker.user) envs.push(`INSIGHTD_MQTT_USER=${broker.user}`);
  if (broker.pass) envs.push(`INSIGHTD_MQTT_PASS=${broker.pass}`);
  if (p.allowUpdates) envs.push('INSIGHTD_ALLOW_UPDATES=true');
  if (p.allowActions) envs.push('INSIGHTD_ALLOW_ACTIONS=true');
  pushAdvanced(envs, 'INSIGHTD_COLLECT_INTERVAL',  a.collectInterval,  '5');
  pushAdvanced(envs, 'INSIGHTD_UPDATE_CHECK_CRON', a.updateCheckCron, '0 3 * * *');
  pushAdvanced(envs, 'TZ',                          a.tz,              'UTC');
  pushAdvanced(envs, 'INSIGHTD_DISK_WARN_THRESHOLD', a.diskWarnThreshold, '85');
  pushAdvanced(envs, 'INSIGHTD_LOG_LINES',           a.logLines,        '100');
  pushAdvanced(envs, 'INSIGHTD_LOG_MAX_LINES',       a.logMaxLines,     '1000');
  if (a.image) envs.push(`INSIGHTD_IMAGE=${a.image}`);
  return `${envs.join(' ')} curl -fsSL https://get.insightd.org/install | bash`;
}

function pushAdvanced(envs: string[], name: string, value: string | undefined, defaultValue: string): void {
  if (!value || value === defaultValue) return;
  const needsQuoting = /\s/.test(value);
  envs.push(needsQuoting ? `${name}="${value}"` : `${name}=${value}`);
}
