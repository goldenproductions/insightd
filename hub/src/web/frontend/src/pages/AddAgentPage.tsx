import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { AgentSetup } from '@/types/api';
import { Card } from '@/components/Card';
import { FormField, Input, Select } from '@/components/FormField';
import { CommandBlock } from '@/components/CommandBlock';
import { PageTitle } from '@/components/PageTitle';

export function AddAgentPage() {
  const { data: defaults } = useQuery({
    queryKey: ['agent-setup'],
    queryFn: () => api<AgentSetup>('/agent-setup'),
    refetchInterval: false,
  });

  // Required
  const [hostId, setHostId] = useState('');
  const [mqttUrl, setMqttUrl] = useState('');
  const [mqttUser, setMqttUser] = useState('');
  const [mqttPass, setMqttPass] = useState('');
  const [image, setImage] = useState('');

  // Permissions
  const [allowUpdates, setAllowUpdates] = useState(true);
  const [allowActions, setAllowActions] = useState(true);

  // Collection & scheduling
  const [collectInterval, setCollectInterval] = useState('');
  const [updateCheckCron, setUpdateCheckCron] = useState('');
  const [tz, setTz] = useState('');

  // Thresholds & limits
  const [diskWarnThreshold, setDiskWarnThreshold] = useState('');
  const [logLines, setLogLines] = useState('');
  const [logMaxLines, setLogMaxLines] = useState('');

  const effectiveMqttUrl = mqttUrl || defaults?.mqttUrl || '';
  const effectiveMqttUser = mqttUser || defaults?.mqttUser || '';
  const effectiveMqttPass = mqttPass || defaults?.mqttPass || '';
  const effectiveImage = image || defaults?.image || 'andreas404/insightd-agent:latest';

  const envLines: (string | null)[] = [
    `  -e INSIGHTD_HOST_ID=${hostId || '<host-id>'} \\`,
    `  -e INSIGHTD_MQTT_URL=${effectiveMqttUrl} \\`,
    effectiveMqttUser ? `  -e INSIGHTD_MQTT_USER=${effectiveMqttUser} \\` : null,
    effectiveMqttPass ? `  -e INSIGHTD_MQTT_PASS=${effectiveMqttPass} \\` : null,
    allowUpdates ? '  -e INSIGHTD_ALLOW_UPDATES=true \\' : null,
    allowActions ? '  -e INSIGHTD_ALLOW_ACTIONS=true \\' : null,
    collectInterval && collectInterval !== '5' ? `  -e INSIGHTD_COLLECT_INTERVAL=${collectInterval} \\` : null,
    updateCheckCron && updateCheckCron !== '0 3 * * *' ? `  -e INSIGHTD_UPDATE_CHECK_CRON="${updateCheckCron}" \\` : null,
    tz && tz !== 'UTC' ? `  -e TZ=${tz} \\` : null,
    diskWarnThreshold && diskWarnThreshold !== '85' ? `  -e INSIGHTD_DISK_WARN_THRESHOLD=${diskWarnThreshold} \\` : null,
    logLines && logLines !== '100' ? `  -e INSIGHTD_LOG_LINES=${logLines} \\` : null,
    logMaxLines && logMaxLines !== '1000' ? `  -e INSIGHTD_LOG_MAX_LINES=${logMaxLines} \\` : null,
  ];

  const command = [
    'docker run -d \\',
    '  --name insightd-agent \\',
    '  --restart unless-stopped \\',
    `  -v /var/run/docker.sock:/var/run/docker.sock${allowUpdates ? '' : ':ro'} \\`,
    '  -v /:/host:ro \\',
    ...envLines.filter(Boolean),
    `  ${effectiveImage}`,
  ].join('\n');

  return (
    <div className="space-y-6">
      <PageTitle>Add Agent</PageTitle>
      <p className="text-sm text-muted">
        Configure and copy the command below to deploy an agent on a remote host.
        Only non-default values are included in the command.
      </p>

      <Card title="Connection">
        <div className="space-y-4">
          <FormField label="Host ID" description="Unique name for this host (e.g. nas-01, web-server)">
            <Input value={hostId} onChange={e => setHostId(e.target.value)} placeholder="e.g. nas-01, web-server" />
          </FormField>
          <FormField label="MQTT URL" description="Broker address the agent connects to">
            <Input value={mqttUrl} onChange={e => setMqttUrl(e.target.value)} placeholder={defaults?.mqttUrl} />
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="MQTT User">
              <Input value={mqttUser} onChange={e => setMqttUser(e.target.value)} placeholder={defaults?.mqttUser} />
            </FormField>
            <FormField label="MQTT Password">
              <Input value={mqttPass} onChange={e => setMqttPass(e.target.value)} placeholder={defaults?.mqttPass} />
            </FormField>
          </div>
          <FormField label="Docker Image">
            <Input value={image} onChange={e => setImage(e.target.value)} placeholder={defaults?.image} />
          </FormField>
        </div>
      </Card>

      <Card title="Permissions">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Remote Updates" description="Allow the hub to update this agent remotely">
            <Select value={allowUpdates ? '1' : '0'} onChange={e => setAllowUpdates(e.target.value === '1')}>
              <option value="1">Enabled</option>
              <option value="0">Disabled</option>
            </Select>
          </FormField>
          <FormField label="Container Actions" description="Allow start/stop/restart/remove from the hub UI">
            <Select value={allowActions ? '1' : '0'} onChange={e => setAllowActions(e.target.value === '1')}>
              <option value="1">Enabled</option>
              <option value="0">Disabled</option>
            </Select>
          </FormField>
        </div>
      </Card>

      <Card title="Collection & Scheduling">
        <div className="grid gap-4 sm:grid-cols-3">
          <FormField label="Collection Interval" description="How often metrics are collected (minutes)">
            <Input value={collectInterval} onChange={e => setCollectInterval(e.target.value)} placeholder="5" type="number" />
          </FormField>
          <FormField label="Update Check Cron" description="When to check for image updates">
            <Input value={updateCheckCron} onChange={e => setUpdateCheckCron(e.target.value)} placeholder="0 3 * * *" />
          </FormField>
          <FormField label="Timezone" description="For cron schedules and log timestamps">
            <Input value={tz} onChange={e => setTz(e.target.value)} placeholder="UTC" />
          </FormField>
        </div>
      </Card>

      <Card title="Thresholds & Limits">
        <div className="grid gap-4 sm:grid-cols-3">
          <FormField label="Disk Warning %" description="Warn when disk usage exceeds this">
            <Input value={diskWarnThreshold} onChange={e => setDiskWarnThreshold(e.target.value)} placeholder="85" type="number" />
          </FormField>
          <FormField label="Log Lines" description="Default lines when tailing logs">
            <Input value={logLines} onChange={e => setLogLines(e.target.value)} placeholder="100" type="number" />
          </FormField>
          <FormField label="Max Log Lines" description="Maximum lines for log requests">
            <Input value={logMaxLines} onChange={e => setLogMaxLines(e.target.value)} placeholder="1000" type="number" />
          </FormField>
        </div>
      </Card>

      <Card title="Install Command">
        <CommandBlock command={command} />
      </Card>
    </div>
  );
}
