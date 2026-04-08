import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiAuth } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import type { Webhook, WebhookTestResult } from '@/types/api';
import { useAuth } from '@/context/AuthContext';
import { Card } from '@/components/Card';
import { DataTable, type Column } from '@/components/DataTable';
import { Badge } from '@/components/Badge';
import { LinkButton } from '@/components/FormField';
import { useState } from 'react';
import { PageTitle } from '@/components/PageTitle';
import { EmptyState } from '@/components/EmptyState';

const typeLabels: Record<string, string> = {
  slack: 'Slack', discord: 'Discord', telegram: 'Telegram', ntfy: 'ntfy', generic: 'Generic',
};

export function WebhooksPage() {
  const { isAuthenticated, token } = useAuth();
  const queryClient = useQueryClient();
  const [testResult, setTestResult] = useState<Record<number, { ok: boolean; msg: string }>>({});

  const { data: webhooks } = useQuery({
    queryKey: queryKeys.webhooks(),
    queryFn: () => apiAuth<Webhook[]>('GET', '/webhooks', undefined, token),
    enabled: isAuthenticated,
    refetchInterval: false,
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      apiAuth('PUT', `/webhooks/${id}`, { enabled }, token),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.webhooks() }),
  });

  const testMutation = useMutation({
    mutationFn: (id: number) => apiAuth<WebhookTestResult>('POST', `/webhooks/${id}/test`, undefined, token),
    onSuccess: (data, id) => {
      setTestResult(prev => ({ ...prev, [id]: { ok: data.ok, msg: data.ok ? 'Sent!' : `Failed: ${data.error || data.status}` } }));
      setTimeout(() => setTestResult(prev => { const n = { ...prev }; delete n[id]; return n; }), 3000);
    },
    onError: (err, id) => {
      setTestResult(prev => ({ ...prev, [id]: { ok: false, msg: err instanceof Error ? err.message : 'Failed' } }));
    },
  });

  if (!isAuthenticated) {
    return <EmptyState message="Log in to manage webhooks." />;
  }

  const columns: Column<Webhook>[] = [
    { header: 'Name', accessor: r => r.name },
    { header: 'Type', accessor: r => <Badge text={typeLabels[r.type] || r.type} color="blue" /> },
    { header: 'Alerts', accessor: r => r.on_alert ? <Badge text="on" color="green" /> : <Badge text="off" color="gray" /> },
    { header: 'Digest', accessor: r => r.on_digest ? <Badge text="on" color="green" /> : <Badge text="off" color="gray" /> },
    {
      header: 'Enabled',
      accessor: r => (
        <button
          onClick={e => { e.stopPropagation(); toggleMutation.mutate({ id: r.id, enabled: !r.enabled }); }}
          className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${r.enabled ? 'bg-success/20 text-success' : 'bg-gray-500/20 text-gray-400'}`}
        >
          {r.enabled ? 'Enabled' : 'Disabled'}
        </button>
      ),
    },
    {
      header: 'Test',
      accessor: r => {
        const result = testResult[r.id];
        if (result) return <span className={`text-xs ${result.ok ? 'text-success' : 'text-danger'}`}>{result.msg}</span>;
        return (
          <button
            onClick={e => { e.stopPropagation(); testMutation.mutate(r.id); }}
            className="rounded-lg px-2.5 py-1 text-xs font-medium transition-colors bg-bg-secondary border border-border text-secondary"
          >
            Test
          </button>
        );
      },
    },
  ];

  return (
    <div className="space-y-6">
      <PageTitle actions={
        <LinkButton to="/webhooks/new" variant="primary">
          Add Webhook
        </LinkButton>
      }>Webhooks</PageTitle>
      <Card>
        <DataTable columns={columns} data={webhooks || []} emptyText="No webhooks configured." />
      </Card>
    </div>
  );
}
