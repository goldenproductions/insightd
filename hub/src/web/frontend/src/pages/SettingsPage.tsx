import { useRef, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate } from 'react-router-dom';
import { apiAuth } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import type { SettingsResponse, StorageInfo, VacuumResult } from '@/types/api';
import { useAuth } from '@/context/AuthContext';
import { useFormMessage } from '@/hooks/useFormMessage';
import { Card } from '@/components/Card';
import { FormField, Input, Select, Button } from '@/components/FormField';
import { AlertBanner } from '@/components/AlertBanner';
import { PageTitle } from '@/components/PageTitle';
import { LoadingState } from '@/components/LoadingState';
import { fmtBytes, timeAgo } from '@/lib/formatters';

export function SettingsPage() {
  const { isAuthenticated, token, logout } = useAuth();
  const { msg, showSuccess, showWarning, showError } = useFormMessage();
  const formRef = useRef<Record<string, string>>({});

  const { data, error } = useQuery({
    queryKey: queryKeys.settings(),
    queryFn: () => apiAuth<SettingsResponse>('GET', '/settings', undefined, token),
    enabled: isAuthenticated,
    refetchInterval: false,
  });

  // Logout on stale token (401 after hub restart)
  useEffect(() => {
    if (error instanceof Error && (error.message.includes('401') || error.message.includes('Unauthorized'))) {
      logout();
    }
  }, [error, logout]);

  if (!isAuthenticated) return <Navigate to="/login" replace />;

  if (error) {
    return <AlertBanner message={error instanceof Error ? error.message : 'Failed to load settings'} color="red" />;
  }

  if (!data) return <LoadingState />;

  const save = async () => {
    try {
      const result = await apiAuth<{ saved: boolean; restartRequired: boolean }>('PUT', '/settings', formRef.current, token);
      if (result.restartRequired) {
        showWarning('Settings saved. Some changes require a restart to take effect.');
      } else {
        showSuccess('Settings saved.');
      }
    } catch (err) {
      showError(err);
    }
  };

  return (
    <div className="space-y-6">
      <PageTitle>Settings</PageTitle>

      {Object.entries(data.categories).map(([category, settings]) => (
        <Card key={category} title={category}>
          <div className="space-y-4">
            {settings.map(s => {
              const onChange = (val: string) => { formRef.current[s.key] = val; };
              return (
                <FormField key={s.key} label={s.label} hint={s.hotReload ? undefined : 'requires restart'} source={s.source} description={s.description || undefined}>
                  {s.type === 'bool' ? (
                    <Select defaultValue={s.value} onChange={e => onChange(e.target.value)}>
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </Select>
                  ) : s.sensitive ? (
                    <Input type="password" defaultValue={s.value} onChange={e => onChange(e.target.value)} placeholder="unchanged" />
                  ) : s.type === 'int' || s.type === 'float' ? (
                    <Input type="number" defaultValue={s.value} onChange={e => onChange(e.target.value)} step={s.type === 'float' ? '0.1' : '1'} />
                  ) : (
                    <Input type="text" defaultValue={s.value} onChange={e => onChange(e.target.value)} />
                  )}
                </FormField>
              );
            })}
          </div>
        </Card>
      ))}

      {msg && <AlertBanner message={msg.text} color={msg.color} />}
      <Button onClick={save}>Save Settings</Button>

      <StorageCard token={token} />
    </div>
  );
}

function StorageCard({ token }: { token: string | null }) {
  const queryClient = useQueryClient();
  const [vacuuming, setVacuuming] = useState(false);
  const [vacuumMsg, setVacuumMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const { data } = useQuery({
    queryKey: queryKeys.storage(),
    queryFn: () => apiAuth<StorageInfo>('GET', '/storage', undefined, token),
    enabled: !!token,
    refetchInterval: 60_000,
  });

  if (!data) return null;

  const runVacuum = async () => {
    setVacuuming(true);
    setVacuumMsg(null);
    try {
      const r = await apiAuth<VacuumResult>('POST', '/storage/vacuum', undefined, token);
      setVacuumMsg({ text: `Reclaimed ${fmtBytes(r.reclaimed)}`, ok: true });
      queryClient.invalidateQueries({ queryKey: queryKeys.storage() });
    } catch (err) {
      setVacuumMsg({ text: err instanceof Error ? err.message : 'Vacuum failed', ok: false });
    } finally {
      setVacuuming(false);
    }
  };

  return (
    <Card title="Storage">
      <div className="space-y-4">
        {/* DB size */}
        <div>
          <div className="text-2xl font-bold text-fg">{fmtBytes(data.dbSizeBytes)}</div>
          <div className="mt-1 h-2 rounded-full bg-border overflow-hidden">
            <div className="h-full rounded-full bg-info transition-all" style={{ width: `${Math.min(100, Math.max(5, (data.dbSizeBytes / (500 * 1024 * 1024)) * 100))}%` }} />
          </div>
          <div className="mt-1 text-xs text-muted">Database size on disk</div>
        </div>

        {/* Retention + cleanup info */}
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <div className="text-xs font-medium text-muted">Raw data kept</div>
            <div className="text-fg">{data.retention.rawDays} days</div>
          </div>
          <div>
            <div className="text-xs font-medium text-muted">Rollup data kept</div>
            <div className="text-fg">{data.retention.rollupDays} days</div>
          </div>
          <div>
            <div className="text-xs font-medium text-muted">Last cleanup</div>
            <div className="text-fg">{timeAgo(data.lastPruneAt)}</div>
          </div>
          <div>
            <div className="text-xs font-medium text-muted">Last vacuum</div>
            <div className="text-fg">{timeAgo(data.lastVacuumAt)}</div>
          </div>
        </div>

        {/* Vacuum action */}
        <div className="flex items-center gap-3">
          <Button onClick={runVacuum} disabled={vacuuming} size="sm" variant="secondary">
            {vacuuming ? 'Vacuuming...' : 'Vacuum Now'}
          </Button>
          {vacuumMsg && (
            <span className={`text-xs ${vacuumMsg.ok ? 'text-success' : 'text-danger'}`}>{vacuumMsg.text}</span>
          )}
        </div>
      </div>
    </Card>
  );
}
