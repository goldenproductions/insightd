import { useState } from 'react';
import { useParams, useNavigate, Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiAuth } from '@/lib/api';
import type { Webhook } from '@/types/api';
import { useAuth } from '@/context/AuthContext';
import { Card } from '@/components/Card';
import { FormField, Input, Select, Button } from '@/components/FormField';
import { AlertBanner } from '@/components/AlertBanner';
import { PageTitle } from '@/components/PageTitle';
import { BackLink } from '@/components/BackLink';

const typeHelp: Record<string, string> = {
  slack: 'Create an incoming webhook in your Slack workspace settings. Paste the webhook URL.',
  discord: 'Go to Server Settings → Integrations → Webhooks → New Webhook. Copy the webhook URL.',
  telegram: 'Create a bot via @BotFather, copy the bot token. Get your chat ID from @userinfobot.',
  ntfy: 'Use ntfy.sh/your-topic or your self-hosted ntfy server URL (e.g. https://ntfy.example.com/my-topic).',
  generic: 'Enter any HTTP endpoint that accepts POST requests with JSON. Optionally add an Authorization header.',
};

export function WebhookFormPage() {
  const { webhookId } = useParams();
  const { isAuthenticated, token } = useAuth();
  const isEdit = !!webhookId;

  const { data: existing, isLoading } = useQuery({
    queryKey: ['webhook', webhookId],
    queryFn: () => apiAuth<Webhook>('GET', `/webhooks/${webhookId}`, undefined, token),
    enabled: isEdit && isAuthenticated,
    refetchInterval: false,
  });

  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (isEdit && isLoading) return null;

  return <WebhookForm key={webhookId ?? 'new'} existing={existing} isEdit={isEdit} webhookId={webhookId} token={token} />;
}

function WebhookForm({ existing, isEdit, webhookId, token }: { existing?: Webhook; isEdit: boolean; webhookId?: string; token: string | null }) {
  const navigate = useNavigate();

  const [name, setName] = useState(existing?.name ?? '');
  const [type, setType] = useState<string>(existing?.type ?? 'slack');
  const [url, setUrl] = useState(existing?.url ?? '');
  const [secret, setSecret] = useState(existing?.secret ?? '');
  const [onAlert, setOnAlert] = useState(existing?.on_alert != null ? (existing.on_alert ? '1' : '0') : '1');
  const [onDigest, setOnDigest] = useState(existing?.on_digest != null ? (existing.on_digest ? '1' : '0') : '1');
  const [enabled, setEnabled] = useState(existing?.enabled != null ? (existing.enabled ? '1' : '0') : '1');
  const [msg, setMsg] = useState<{ text: string; color: string } | null>(null);

  const save = async () => {
    const body = { name, type, url, secret: secret || null, onAlert: onAlert === '1', onDigest: onDigest === '1', enabled: enabled === '1' };
    try {
      if (isEdit) {
        await apiAuth('PUT', `/webhooks/${webhookId}`, body, token);
        setMsg({ text: 'Webhook updated.', color: 'green' });
      } else {
        await apiAuth('POST', '/webhooks', body, token);
        setMsg({ text: 'Webhook created.', color: 'green' });
        setTimeout(() => navigate('/webhooks'), 500);
      }
    } catch (err) {
      setMsg({ text: err instanceof Error ? err.message : 'Failed', color: 'red' });
    }
  };

  const remove = async () => {
    if (!confirm('Delete this webhook?')) return;
    try {
      await apiAuth('DELETE', `/webhooks/${webhookId}`, undefined, token);
      navigate('/webhooks');
    } catch (err) {
      setMsg({ text: err instanceof Error ? err.message : 'Failed', color: 'red' });
    }
  };

  const urlLabel = type === 'telegram' ? 'Bot Token' : 'Webhook URL';
  const urlPlaceholder = type === 'telegram' ? '123456:ABC-DEF...' : type === 'ntfy' ? 'https://ntfy.sh/my-topic' : 'https://...';
  const showSecret = type === 'telegram' || type === 'generic';
  const secretLabel = type === 'telegram' ? 'Chat ID' : 'Authorization Header';
  const secretPlaceholder = type === 'telegram' ? '-1001234567890' : 'Bearer your-token';

  return (
    <div className="space-y-6">
      <BackLink to="/webhooks" label="Back" />
      <PageTitle>{isEdit ? 'Edit Webhook' : 'Add Webhook'}</PageTitle>

      <Card className="max-w-xl">
        <div className="space-y-4">
          <FormField label="Name">
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. My Slack Channel" maxLength={100} />
          </FormField>

          <FormField label="Type">
            <Select value={type} onChange={e => setType(e.target.value)}>
              <option value="slack">Slack</option>
              <option value="discord">Discord</option>
              <option value="telegram">Telegram</option>
              <option value="ntfy">ntfy</option>
              <option value="generic">Generic Webhook</option>
            </Select>
          </FormField>

          {typeHelp[type] && (
            <p className="rounded-lg p-3 text-xs bg-bg-secondary text-muted">
              {typeHelp[type]}
            </p>
          )}

          <FormField label={urlLabel}>
            <Input value={url} onChange={e => setUrl(e.target.value)} placeholder={urlPlaceholder} />
          </FormField>

          {showSecret && (
            <FormField label={secretLabel}>
              <Input value={secret} onChange={e => setSecret(e.target.value)} placeholder={secretPlaceholder} />
            </FormField>
          )}

          <div className="grid grid-cols-3 gap-4">
            <FormField label="Send Alerts">
              <Select value={onAlert} onChange={e => setOnAlert(e.target.value)}>
                <option value="1">Yes</option>
                <option value="0">No</option>
              </Select>
            </FormField>
            <FormField label="Send Digests">
              <Select value={onDigest} onChange={e => setOnDigest(e.target.value)}>
                <option value="1">Yes</option>
                <option value="0">No</option>
              </Select>
            </FormField>
            <FormField label="Enabled">
              <Select value={enabled} onChange={e => setEnabled(e.target.value)}>
                <option value="1">Yes</option>
                <option value="0">No</option>
              </Select>
            </FormField>
          </div>

          {msg && <AlertBanner message={msg.text} color={msg.color} />}

          <div className="flex gap-3">
            <Button onClick={save}>{isEdit ? 'Update' : 'Create'}</Button>
            {isEdit && <Button variant="danger" onClick={remove}>Delete</Button>}
          </div>
        </div>
      </Card>
    </div>
  );
}
