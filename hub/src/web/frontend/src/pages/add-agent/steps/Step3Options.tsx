import { FormField, Input, Select } from '@/components/FormField';
import type { WizardState } from '../types';
import { validateImage } from '../validation';

interface AdvancedField { key: keyof WizardState['advanced']; label: string; placeholder: string; help?: string }

const ADVANCED_PER_TARGET: Record<NonNullable<WizardState['target']>, AdvancedField[]> = {
  docker: dockerLikeAdvanced(),
  'in-guest': dockerLikeAdvanced(),
  pve: dockerLikeAdvanced(),
  k8s: [
    { key: 'collectInterval',    label: 'Collection interval (min)', placeholder: '5'   },
    { key: 'tz',                  label: 'Timezone',                   placeholder: 'UTC' },
    { key: 'diskWarnThreshold',   label: 'Disk warning %',             placeholder: '85'  },
    { key: 'image',               label: 'Image',                      placeholder: 'andreas404/insightd-agent:latest' },
  ],
};

function dockerLikeAdvanced(): AdvancedField[] {
  return [
    { key: 'collectInterval',    label: 'Collection interval (min)', placeholder: '5'         },
    { key: 'updateCheckCron',    label: 'Update-check cron',          placeholder: '0 3 * * *' },
    { key: 'tz',                  label: 'Timezone',                   placeholder: 'UTC'      },
    { key: 'diskWarnThreshold',   label: 'Disk warning %',             placeholder: '85'       },
    { key: 'logLines',            label: 'Default log lines',          placeholder: '100'      },
    { key: 'logMaxLines',         label: 'Max log lines',              placeholder: '1000'     },
    { key: 'image',               label: 'Image',                      placeholder: 'andreas404/insightd-agent:latest' },
  ];
}

export function Step3Options({ state, setState }: { state: WizardState; setState: (u: (s: WizardState) => WizardState) => void }) {
  const target = state.target!;
  const showAllowUpdates = target !== 'k8s';
  const fields = ADVANCED_PER_TARGET[target];

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2">
        {showAllowUpdates && (
          <FormField label="Remote updates" description="Allow the hub to update this agent remotely.">
            <Select
              value={state.permissions.allowUpdates ? '1' : '0'}
              onChange={e => setState(s => ({ ...s, permissions: { ...s.permissions, allowUpdates: e.target.value === '1' } }))}
            >
              <option value="1">Enabled</option>
              <option value="0">Disabled</option>
            </Select>
          </FormField>
        )}
        <FormField
          label="Container actions"
          description={target === 'pve' ? 'Allow start/stop/restart, plus pct/qm guest control.' : 'Allow start/stop/restart/remove from the hub UI.'}
        >
          <Select
            value={state.permissions.allowActions ? '1' : '0'}
            onChange={e => setState(s => ({ ...s, permissions: { ...s.permissions, allowActions: e.target.value === '1' } }))}
          >
            <option value="1">Enabled</option>
            <option value="0">Disabled</option>
          </Select>
        </FormField>
      </div>

      <button
        type="button"
        onClick={() => setState(s => ({ ...s, advancedOpen: !s.advancedOpen }))}
        className="text-sm text-info hover:underline"
      >
        {state.advancedOpen ? '▾' : '▸'} {state.advancedOpen ? 'Hide' : 'Show'} advanced ({fields.length} settings)
      </button>

      {state.advancedOpen && (
        <div className="grid gap-3 sm:grid-cols-2">
          {fields.map(f => (
            <FormField key={f.key} label={f.label}>
              <Input
                value={state.advanced[f.key] ?? ''}
                onChange={e => setState(s => ({ ...s, advanced: { ...s.advanced, [f.key]: e.target.value } }))}
                placeholder={f.placeholder}
              />
              {f.key === 'image' && state.advanced.image && validateImage(state.advanced.image) && (
                <p className="text-xs text-warning">{validateImage(state.advanced.image)}</p>
              )}
            </FormField>
          ))}
        </div>
      )}
    </div>
  );
}
