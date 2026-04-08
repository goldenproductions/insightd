import { useState } from 'react';
import { useParams, useNavigate, Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, apiAuth } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import type { EndpointDetail } from '@/types/api';
import { useAuth } from '@/context/AuthContext';
import { Card } from '@/components/Card';
import { FormField, Input, Select, Button } from '@/components/FormField';
import { AlertBanner } from '@/components/AlertBanner';
import { PageTitle } from '@/components/PageTitle';
import { BackLink } from '@/components/BackLink';

export function EndpointFormPage() {
  const { endpointId } = useParams();
  const { isAuthenticated, token } = useAuth();
  const isEdit = !!endpointId;

  const { data: existing, isLoading } = useQuery({
    queryKey: queryKeys.endpoint(endpointId),
    queryFn: () => api<EndpointDetail>(`/endpoints/${endpointId}`),
    enabled: isEdit,
    refetchInterval: false,
  });

  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (isEdit && isLoading) return null;

  return <EndpointForm key={endpointId ?? 'new'} existing={existing} isEdit={isEdit} endpointId={endpointId} token={token} />;
}

function EndpointForm({ existing, isEdit, endpointId, token }: { existing?: EndpointDetail; isEdit: boolean; endpointId?: string; token: string | null }) {
  const navigate = useNavigate();

  const [name, setName] = useState(existing?.name ?? '');
  const [url, setUrl] = useState(existing?.url ?? '');
  const [method, setMethod] = useState(existing?.method ?? 'GET');
  const [expectedStatus, setExpectedStatus] = useState(String(existing?.expected_status ?? 200));
  const [intervalSeconds, setIntervalSeconds] = useState(String(existing?.interval_seconds ?? 60));
  const [timeoutMs, setTimeoutMs] = useState(String(existing?.timeout_ms ?? 10000));
  const [headers, setHeaders] = useState(existing?.headers ?? '');
  const [enabled, setEnabled] = useState(existing?.enabled != null ? (existing.enabled ? '1' : '0') : '1');
  const [msg, setMsg] = useState<{ text: string; color: string } | null>(null);

  const save = async () => {
    const body = {
      name, url, method,
      expectedStatus: parseInt(expectedStatus, 10),
      intervalSeconds: parseInt(intervalSeconds, 10),
      timeoutMs: parseInt(timeoutMs, 10),
      headers: headers || null,
      enabled: enabled === '1',
    };
    try {
      if (isEdit) {
        await apiAuth('PUT', `/endpoints/${endpointId}`, body, token);
        setMsg({ text: 'Endpoint updated.', color: 'green' });
      } else {
        const result = await apiAuth<{ id: number }>('POST', '/endpoints', body, token);
        setMsg({ text: 'Endpoint created.', color: 'green' });
        setTimeout(() => navigate(`/endpoints/${result.id}`), 500);
      }
    } catch (err) {
      setMsg({ text: err instanceof Error ? err.message : 'Failed', color: 'red' });
    }
  };

  const remove = async () => {
    if (!confirm('Delete this endpoint and all its check history?')) return;
    try {
      await apiAuth('DELETE', `/endpoints/${endpointId}`, undefined, token);
      navigate('/endpoints');
    } catch (err) {
      setMsg({ text: err instanceof Error ? err.message : 'Failed', color: 'red' });
    }
  };

  return (
    <div className="space-y-6">
      <BackLink to={isEdit ? `/endpoints/${endpointId}` : '/endpoints'} label="Back" />
      <PageTitle>{isEdit ? 'Edit Endpoint' : 'Add Endpoint'}</PageTitle>

      <Card className="max-w-xl">
        <div className="space-y-4">
          <FormField label="Name">
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. My API Health Check" maxLength={100} />
          </FormField>
          <FormField label="URL">
            <Input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://api.example.com/health" />
          </FormField>
          <FormField label="Method">
            <Select value={method} onChange={e => setMethod(e.target.value)}>
              <option value="GET">GET</option>
              <option value="HEAD">HEAD</option>
            </Select>
          </FormField>
          <FormField label="Expected Status Code">
            <Input type="number" value={expectedStatus} onChange={e => setExpectedStatus(e.target.value)} min={100} max={599} />
          </FormField>
          <FormField label="Check Interval (seconds)">
            <Input type="number" value={intervalSeconds} onChange={e => setIntervalSeconds(e.target.value)} min={10} max={3600} />
          </FormField>
          <FormField label="Timeout (ms)">
            <Input type="number" value={timeoutMs} onChange={e => setTimeoutMs(e.target.value)} min={1000} max={30000} />
          </FormField>
          <FormField label="Custom Headers (JSON, optional)">
            <Input value={headers} onChange={e => setHeaders(e.target.value)} placeholder='{"Authorization":"Bearer ..."}' />
          </FormField>
          <FormField label="Enabled">
            <Select value={enabled} onChange={e => setEnabled(e.target.value)}>
              <option value="1">Yes</option>
              <option value="0">No</option>
            </Select>
          </FormField>

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
