import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { FormField, Input } from '@/components/FormField';
import type { WizardState, BrokerDefaults } from '../types';
import { validateIdentifier, validateBrokerUrl } from '../validation';

const IDENTIFIER_LABEL: Record<NonNullable<WizardState['target']>, { label: string; placeholder: string; help: string }> = {
  docker:     { label: 'Host ID',      placeholder: 'nas-01',      help: 'Unique name for this host. Used in URLs and reports.' },
  'in-guest': { label: 'Host ID',      placeholder: 'n8n-vm',      help: 'Unique name for this guest. The PVE side identifies it via SMBIOS UUID or hostname/MAC.' },
  pve:        { label: 'Host ID',      placeholder: 'proxmox-01',  help: 'Should match the PVE node hostname (output of `hostname` on the PVE shell).' },
  k8s:        { label: 'Cluster name', placeholder: 'homelab-k3s', help: 'Applied to all DaemonSet pods. Used to group nodes in the UI.' },
};

interface HostsRow { host_id: string }

export function Step2Connection({ state, setState }: { state: WizardState; setState: (u: (s: WizardState) => WizardState) => void }) {
  const { data: defaults, isError: brokerDefaultsFailed } = useQuery({
    queryKey: queryKeys.agentSetup(),
    queryFn: () => api<BrokerDefaults>('/agent-setup'),
    refetchInterval: false,
  });

  useEffect(() => {
    if (brokerDefaultsFailed && state.useDefaultBroker) {
      setState(s => ({ ...s, useDefaultBroker: false }));
    }
  }, [brokerDefaultsFailed, state.useDefaultBroker, setState]);
  const { data: hosts } = useQuery({
    queryKey: queryKeys.hosts(),
    queryFn: () => api<HostsRow[]>('/hosts'),
    refetchInterval: false,
  });

  const target = state.target!;
  const ident = IDENTIFIER_LABEL[target];
  const collision = hosts?.some(h => h.host_id === state.identifier.trim()) ?? false;
  const idError      = state.identifier ? validateIdentifier(state.identifier) : null;
  const urlError     = state.useDefaultBroker ? null : validateBrokerUrl(state.mqttUrl);

  return (
    <div className="space-y-5">
      <FormField label={ident.label} description={ident.help}>
        <Input
          value={state.identifier}
          onChange={e => setState(s => ({ ...s, identifier: e.target.value }))}
          placeholder={ident.placeholder}
          autoFocus
        />
      </FormField>
      {idError && <p className="text-xs text-warning">{idError}</p>}
      {collision && target !== 'k8s' && (
        <p className="rounded border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
          Host ID '{state.identifier}' already exists. Continuing will replace its agent.
        </p>
      )}

      <div className="space-y-3">
        {brokerDefaultsFailed && (
          <p className="rounded border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
            Could not load broker defaults from the hub. Enter MQTT settings manually below.
          </p>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={state.useDefaultBroker}
            onChange={e => setState(s => ({ ...s, useDefaultBroker: e.target.checked }))}
            disabled={brokerDefaultsFailed}
          />
          Use the hub's default broker
        </label>

        <FormField label="MQTT URL">
          <Input
            value={state.useDefaultBroker ? '' : state.mqttUrl}
            onChange={e => setState(s => ({ ...s, mqttUrl: e.target.value }))}
            placeholder={defaults?.mqttUrl ?? 'mqtt://hub:1883'}
            disabled={state.useDefaultBroker}
          />
        </FormField>
        {urlError && <p className="text-xs text-warning">{urlError}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="MQTT User">
            <Input
              value={state.useDefaultBroker ? '' : state.mqttUser}
              onChange={e => setState(s => ({ ...s, mqttUser: e.target.value }))}
              placeholder={defaults?.mqttUser ?? '(none)'}
              disabled={state.useDefaultBroker}
            />
          </FormField>
          <FormField label="MQTT Password">
            <Input
              value={state.useDefaultBroker ? '' : state.mqttPass}
              onChange={e => setState(s => ({ ...s, mqttPass: e.target.value }))}
              placeholder={defaults?.mqttPass ? '••••••' : '(none)'}
              disabled={state.useDefaultBroker}
            />
          </FormField>
        </div>
      </div>
    </div>
  );
}
