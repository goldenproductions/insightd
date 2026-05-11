import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiAuth } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { Card } from '@/components/Card';
import { Button, Select } from '@/components/FormField';
import { AlertBanner } from '@/components/AlertBanner';
import type { AlertRule, AlertRulesResponse } from '@/types/api';

const RULES_KEY = ['alert-rules'] as const;

export function AlertRulesSection() {
  const { token } = useAuth();
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: RULES_KEY,
    queryFn: () => apiAuth<AlertRulesResponse>('GET', '/alert-rules', undefined, token),
    refetchInterval: false,
  });

  const update = useMutation({
    mutationFn: (args: { type: string; patch: Partial<AlertRule> }) =>
      apiAuth('PUT', `/alert-rules/${args.type}`, args.patch, token),
    onSuccess: () => { setErr(null); qc.invalidateQueries({ queryKey: RULES_KEY }); },
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : 'Update failed'),
  });

  const reset = useMutation({
    mutationFn: () => apiAuth('POST', '/alert-rules/reset', undefined, token),
    onSuccess: () => { setErr(null); qc.invalidateQueries({ queryKey: RULES_KEY }); },
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : 'Reset failed'),
  });

  const rules = data?.rules ?? [];

  return (
    <Card
      title="Alert Rules"
      actions={
        <Button
          variant="secondary"
          size="sm"
          onClick={() => reset.mutate()}
          disabled={reset.isPending}
        >
          {reset.isPending ? 'Resetting…' : 'Reset to defaults'}
        </Button>
      }
    >
      <p className="mb-4 text-sm text-secondary">
        Toggle per-rule mail and webhook delivery, change severity, or disable a rule entirely.
        With <b>Mail critical only</b> on (default), only critical-severity rules can send email.
      </p>

      {err && (
        <div className="mb-3">
          <AlertBanner message={err} color="red" onDismiss={() => setErr(null)} />
        </div>
      )}
      {error && !err && (
        <div className="mb-3">
          <AlertBanner
            message={error instanceof Error ? error.message : 'Failed to load alert rules'}
            color="red"
          />
        </div>
      )}

      {isLoading && rules.length === 0 ? (
        <div className="py-6 text-center text-sm text-muted">Loading…</div>
      ) : rules.length === 0 ? (
        <div className="py-6 text-center text-sm text-muted">No alert rules defined.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wide text-muted">
                <th className="py-2 pr-4 font-medium">Type</th>
                <th className="py-2 pr-4 font-medium">Severity</th>
                <th className="py-2 pr-2 font-medium">Enabled</th>
                <th className="py-2 pr-2 font-medium">Mail</th>
                <th className="py-2 pr-2 font-medium">Webhook</th>
              </tr>
            </thead>
            <tbody>
              {rules.map(r => (
                <tr key={r.alert_type} className="border-b border-border last:border-0 align-top">
                  <td className="py-3 pr-4">
                    <code className="font-mono text-xs text-fg">{r.alert_type}</code>
                    {r.description && (
                      <div className="mt-0.5 text-xs text-secondary">{r.description}</div>
                    )}
                  </td>
                  <td className="py-3 pr-4">
                    <Select
                      value={r.severity}
                      className="w-32"
                      onChange={e =>
                        update.mutate({
                          type: r.alert_type,
                          patch: { severity: e.target.value as AlertRule['severity'] },
                        })
                      }
                    >
                      <option value="critical">critical</option>
                      <option value="warning">warning</option>
                      <option value="info">info</option>
                    </Select>
                  </td>
                  <td className="py-3 pr-2">
                    <input
                      type="checkbox"
                      aria-label={`Enable ${r.alert_type}`}
                      checked={!!r.enabled}
                      onChange={e =>
                        update.mutate({
                          type: r.alert_type,
                          patch: { enabled: e.target.checked ? 1 : 0 },
                        })
                      }
                    />
                  </td>
                  <td className="py-3 pr-2">
                    <input
                      type="checkbox"
                      aria-label={`Email for ${r.alert_type}`}
                      checked={!!r.mail}
                      onChange={e =>
                        update.mutate({
                          type: r.alert_type,
                          patch: { mail: e.target.checked ? 1 : 0 },
                        })
                      }
                    />
                  </td>
                  <td className="py-3 pr-2">
                    <input
                      type="checkbox"
                      aria-label={`Webhook for ${r.alert_type}`}
                      checked={!!r.webhook}
                      onChange={e =>
                        update.mutate({
                          type: r.alert_type,
                          patch: { webhook: e.target.checked ? 1 : 0 },
                        })
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
