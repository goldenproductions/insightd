import { useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Navigate } from 'react-router-dom';
import { apiAuth } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import type { SettingsResponse } from '@/types/api';
import { useAuth } from '@/context/AuthContext';
import { useFormMessage } from '@/hooks/useFormMessage';
import { Card } from '@/components/Card';
import { FormField, Input, Select, Button } from '@/components/FormField';
import { AlertBanner } from '@/components/AlertBanner';
import { PageTitle } from '@/components/PageTitle';
import { LoadingState } from '@/components/LoadingState';

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
    </div>
  );
}
