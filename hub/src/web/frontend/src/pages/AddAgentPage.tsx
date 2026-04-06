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

  const [hostId, setHostId] = useState('');
  const [mqttUrl, setMqttUrl] = useState('');
  const [mqttUser, setMqttUser] = useState('');
  const [mqttPass, setMqttPass] = useState('');
  const [image, setImage] = useState('');
  const [allowUpdates, setAllowUpdates] = useState(true);

  const effectiveMqttUrl = mqttUrl || defaults?.mqttUrl || '';
  const effectiveMqttUser = mqttUser || defaults?.mqttUser || '';
  const effectiveMqttPass = mqttPass || defaults?.mqttPass || '';
  const effectiveImage = image || defaults?.image || 'andreas404/insightd-agent:latest';

  const command = [
    'docker run -d \\',
    '  --name insightd-agent \\',
    '  --restart unless-stopped \\',
    `  -v /var/run/docker.sock:/var/run/docker.sock${allowUpdates ? '' : ':ro'} \\`,
    '  -v /:/host:ro \\',
    `  -e INSIGHTD_HOST_ID=${hostId || '<host-id>'} \\`,
    `  -e INSIGHTD_MQTT_URL=${effectiveMqttUrl} \\`,
    effectiveMqttUser ? `  -e INSIGHTD_MQTT_USER=${effectiveMqttUser} \\` : null,
    effectiveMqttPass ? `  -e INSIGHTD_MQTT_PASS=${effectiveMqttPass} \\` : null,
    allowUpdates ? '  -e INSIGHTD_ALLOW_UPDATES=true \\' : null,
    `  ${effectiveImage}`,
  ].filter(Boolean).join('\n');

  return (
    <div className="space-y-6">
      <PageTitle>Add Agent</PageTitle>
      <p className="text-sm text-muted">
        Configure and copy the command below to deploy an agent on a remote host.
      </p>

      <Card title="Agent Configuration">
        <div className="space-y-4">
          <FormField label="Host ID" description="Unique name for this host">
            <Input value={hostId} onChange={e => setHostId(e.target.value)} placeholder="e.g. nas-01, web-server" />
          </FormField>
          <FormField label="MQTT URL">
            <Input value={mqttUrl} onChange={e => setMqttUrl(e.target.value)} placeholder={defaults?.mqttUrl} />
          </FormField>
          <FormField label="MQTT User">
            <Input value={mqttUser} onChange={e => setMqttUser(e.target.value)} placeholder={defaults?.mqttUser} />
          </FormField>
          <FormField label="MQTT Password">
            <Input value={mqttPass} onChange={e => setMqttPass(e.target.value)} placeholder={defaults?.mqttPass} />
          </FormField>
          <FormField label="Docker Image">
            <Input value={image} onChange={e => setImage(e.target.value)} placeholder={defaults?.image} />
          </FormField>
          <FormField label="Remote Updates" description="Allow the hub to update this agent remotely">
            <Select value={allowUpdates ? '1' : '0'} onChange={e => setAllowUpdates(e.target.value === '1')}>
              <option value="1">Enabled</option>
              <option value="0">Disabled</option>
            </Select>
          </FormField>
        </div>
      </Card>

      <Card title="Install Command">
        <CommandBlock command={command} />
      </Card>
    </div>
  );
}
