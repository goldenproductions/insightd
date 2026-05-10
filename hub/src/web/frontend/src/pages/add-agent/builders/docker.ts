export interface DockerCommandInputs {
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
  };
  image: string;
}

export function buildDockerCommand(i: DockerCommandInputs): string {
  const { identifier, broker, permissions: p, advanced: a, image } = i;
  const socketMount = `/var/run/docker.sock:/var/run/docker.sock${p.allowUpdates ? '' : ':ro'}`;
  const lines: (string | null)[] = [
    `  -e INSIGHTD_HOST_ID=${identifier} \\`,
    `  -e INSIGHTD_MQTT_URL=${broker.url} \\`,
    broker.user        ? `  -e INSIGHTD_MQTT_USER=${broker.user} \\` : null,
    broker.pass        ? `  -e INSIGHTD_MQTT_PASS=${broker.pass} \\` : null,
    p.allowUpdates     ? '  -e INSIGHTD_ALLOW_UPDATES=true \\' : null,
    p.allowActions     ? '  -e INSIGHTD_ALLOW_ACTIONS=true \\' : null,
    advancedLine('INSIGHTD_COLLECT_INTERVAL', a.collectInterval, '5'),
    advancedLine('INSIGHTD_UPDATE_CHECK_CRON', a.updateCheckCron, '0 3 * * *', { quote: true }),
    advancedLine('TZ',                          a.tz,             'UTC'),
    advancedLine('INSIGHTD_DISK_WARN_THRESHOLD', a.diskWarnThreshold, '85'),
    advancedLine('INSIGHTD_LOG_LINES',           a.logLines,        '100'),
    advancedLine('INSIGHTD_LOG_MAX_LINES',       a.logMaxLines,     '1000'),
  ];
  return [
    'docker run -d \\',
    '  --name insightd-agent \\',
    '  --restart unless-stopped \\',
    `  -v ${socketMount} \\`,
    '  -v /:/host:ro \\',
    ...lines.filter(Boolean),
    `  ${image}`,
  ].join('\n');
}

function advancedLine(name: string, value: string | undefined, defaultValue: string, opts: { quote?: boolean } = {}): string | null {
  if (!value || value === defaultValue) return null;
  const v = opts.quote ? `"${value}"` : value;
  return `  -e ${name}=${v} \\`;
}
