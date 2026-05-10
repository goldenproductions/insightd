import { useState } from 'react';
import { PageTitle } from '@/components/PageTitle';
import { Button } from '@/components/FormField';
import type { WizardState } from './types';
import { initialWizardState } from './types';
import { Step1Target } from './steps/Step1Target';
import { Step2Connection } from './steps/Step2Connection';
import { Step3Options } from './steps/Step3Options';
import { Step4Install } from './steps/Step4Install';

const STEP_LABELS = ['Target', 'Connection', 'Options', 'Install'] as const;

export function AddAgentPage() {
  const [state, setState] = useState<WizardState>(initialWizardState);
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);

  const canAdvance =
    step === 1 ? state.target !== null :
    step === 2 ? state.identifier.trim() !== '' && (state.useDefaultBroker || state.mqttUrl.trim() !== '') :
    step === 3 ? true :
    false;

  return (
    <div className="space-y-6">
      <PageTitle>Add Agent</PageTitle>
      <Stepper current={step} onJump={s => s < step && setStep(s)} />
      <div>
        {step === 1 && <Step1Target state={state} setState={setState} />}
        {step === 2 && <Step2Connection state={state} setState={setState} />}
        {step === 3 && <Step3Options state={state} setState={setState} />}
        {step === 4 && <Step4Install state={state} />}
      </div>
      <div className="flex justify-between">
        <Button variant="secondary" onClick={() => setStep(s => Math.max(1, s - 1) as 1|2|3|4)} disabled={step === 1}>
          ← Back
        </Button>
        {step < 4 ? (
          <Button onClick={() => setStep(s => Math.min(4, s + 1) as 1|2|3|4)} disabled={!canAdvance}>
            Next →
          </Button>
        ) : (
          <Button variant="secondary" onClick={() => { window.location.hash = '#/'; }}>
            Close
          </Button>
        )}
      </div>
    </div>
  );
}

function Stepper({ current, onJump }: { current: 1|2|3|4; onJump: (s: 1|2|3|4) => void }) {
  return (
    <ol className="flex items-center gap-2 text-sm">
      {STEP_LABELS.map((label, idx) => {
        const n = (idx + 1) as 1|2|3|4;
        const active = n === current;
        const done = n < current;
        const clickable = done;
        return (
          <li key={label} className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => clickable && onJump(n)}
              disabled={!clickable}
              className={[
                'flex items-center gap-2 rounded-full px-3 py-1',
                active ? 'bg-info text-white' : done ? 'bg-border text-fg' : 'bg-surface text-muted',
                clickable ? 'cursor-pointer hover:opacity-80' : 'cursor-default',
              ].join(' ')}
            >
              <span className="font-mono">{n}</span>
              <span>{label}</span>
            </button>
            {idx < STEP_LABELS.length - 1 && <span className="text-muted">→</span>}
          </li>
        );
      })}
    </ol>
  );
}
