import { useState, useEffect } from 'react';
import { api, apiAuth } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { useFormMessage } from '@/hooks/useFormMessage';
import { Button, Input, Select } from '@/components/FormField';
import { FormField } from '@/components/FormField';
import { AlertBanner } from '@/components/AlertBanner';
import { CommandBlock } from '@/components/CommandBlock';
import type { Host, ContainerSnapshot, AgentSetup } from '@/types/api';

interface Props {
  onComplete: () => void;
  mode: string;
}

export function SetupWizardPage({ onComplete, mode }: Props) {
  const [step, setStep] = useState(0);
  const totalSteps = 6;

  return (
    <div className="flex min-h-screen items-center justify-center p-4 bg-bg">
      <div className="w-full max-w-lg">
        {/* Progress */}
        <div className="mb-8 flex justify-center gap-2">
          {Array.from({ length: totalSteps }).map((_, i) => (
            <div key={i} className={`h-2 w-8 rounded-full transition-colors ${i <= step ? 'bg-info' : 'bg-border'}`} />
          ))}
        </div>

        <div className="rounded-2xl p-8 bg-surface border border-border">
          {step === 0 && <WelcomeStep onNext={() => setStep(1)} />}
          {step === 1 && <PasswordStep onNext={() => setStep(2)} onSkip={() => setStep(2)} />}
          {step === 2 && <EmailStep onNext={() => setStep(3)} onSkip={() => setStep(3)} />}
          {step === 3 && <AgentStep mode={mode} onNext={() => setStep(4)} onSkip={() => setStep(4)} />}
          {step === 4 && <WaitingStep mode={mode} onNext={() => setStep(5)} onSkip={() => setStep(5)} />}
          {step === 5 && <DoneStep onComplete={onComplete} />}
        </div>
      </div>
    </div>
  );
}

function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <div className="text-center">
      <div className="text-4xl mb-4">🔍</div>
      <h1 className="text-2xl font-bold mb-2 text-fg">Welcome to insightd</h1>
      <p className="mb-6 text-sm text-muted">
        Self-hosted server awareness for homelabbers.<br />
        Let's get you set up in under 2 minutes.
      </p>
      <Button onClick={onNext}>Get Started</Button>
    </div>
  );
}

function PasswordStep({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const save = async () => {
    if (password.length < 4) { setError('Password must be at least 4 characters'); return; }
    if (password !== confirm) { setError('Passwords do not match'); return; }
    try {
      await fetch('/api/setup/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      setSaved(true);
      setTimeout(onNext, 1000);
    } catch { setError('Failed to save'); }
  };

  return (
    <div>
      <h2 className="text-xl font-bold mb-1 text-fg">Admin Password</h2>
      <p className="mb-5 text-sm text-muted">Secure your dashboard. Required for settings, webhooks, and updates.</p>
      <div className="space-y-4">
        <FormField label="Password">
          <Input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Choose a password" autoFocus />
        </FormField>
        <FormField label="Confirm Password">
          <Input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="Confirm password"
            onKeyDown={e => e.key === 'Enter' && save()} />
        </FormField>
        {error && <AlertBanner message={error} color="red" />}
        {saved && <AlertBanner message="Password saved!" color="green" />}
        <div className="flex gap-3">
          <Button onClick={save}>Set Password</Button>
          <Button variant="secondary" onClick={onSkip}>Skip for now</Button>
        </div>
      </div>
    </div>
  );
}

function EmailStep({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  const { token } = useAuth();
  const [host, setHost] = useState('');
  const [port, setPort] = useState('587');
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [to, setTo] = useState('');
  const { msg, showSuccess, showError } = useFormMessage();

  const save = async () => {
    try {
      await apiAuth('PUT', '/settings', {
        'smtp.host': host, 'smtp.port': port, 'smtp.user': user, 'smtp.pass': pass, 'smtp.from': user, 'digestTo': to,
        'alerts.enabled': 'true', 'alerts.to': to,
      }, token);
      showSuccess('Email configured!');
      setTimeout(onNext, 1000);
    } catch (err) { showError(err); }
  };

  return (
    <div>
      <h2 className="text-xl font-bold mb-1 text-fg">Email Notifications</h2>
      <p className="mb-5 text-sm text-muted">Get weekly digests and real-time alerts. You can configure this later in Settings.</p>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <FormField label="SMTP Host"><Input value={host} onChange={e => setHost(e.target.value)} placeholder="smtp.gmail.com" /></FormField>
          <FormField label="Port"><Input value={port} onChange={e => setPort(e.target.value)} /></FormField>
        </div>
        <FormField label="SMTP User"><Input value={user} onChange={e => setUser(e.target.value)} placeholder="you@gmail.com" /></FormField>
        <FormField label="SMTP Password"><Input type="password" value={pass} onChange={e => setPass(e.target.value)} placeholder="App password" /></FormField>
        <FormField label="Send alerts & digests to"><Input value={to} onChange={e => setTo(e.target.value)} placeholder="you@gmail.com" /></FormField>
        {msg && <AlertBanner message={msg.text} color={msg.color} />}
        <div className="flex gap-3">
          <Button onClick={save}>Save Email Settings</Button>
          <Button variant="secondary" onClick={onSkip}>Skip</Button>
        </div>
      </div>
    </div>
  );
}

function AgentStep({ mode, onNext, onSkip }: { mode: string; onNext: () => void; onSkip: () => void }) {
  const [hostId, setHostId] = useState('');
  const [allowUpdates, setAllowUpdates] = useState(true);

  const { data: defaults } = useAgentSetup();

  if (mode === 'standalone') {
    return (
      <div className="text-center">
        <div className="text-4xl mb-4">✅</div>
        <h2 className="text-xl font-bold mb-2 text-fg">You're Already Monitoring</h2>
        <p className="mb-5 text-sm text-muted">Standalone mode monitors this host directly. No agent needed.</p>
        <Button onClick={onNext}>Continue</Button>
      </div>
    );
  }

  const command = [
    'docker run -d \\',
    '  --name insightd-agent \\',
    '  --restart unless-stopped \\',
    `  -v /var/run/docker.sock:/var/run/docker.sock${allowUpdates ? '' : ':ro'} \\`,
    '  -v /:/host:ro \\',
    `  -e INSIGHTD_HOST_ID=${hostId || '<host-id>'} \\`,
    `  -e INSIGHTD_MQTT_URL=${defaults?.mqttUrl || 'mqtt://<hub-ip>:1883'} \\`,
    defaults?.mqttUser ? `  -e INSIGHTD_MQTT_USER=${defaults.mqttUser} \\` : null,
    defaults?.mqttPass ? `  -e INSIGHTD_MQTT_PASS=${defaults.mqttPass} \\` : null,
    allowUpdates ? '  -e INSIGHTD_ALLOW_UPDATES=true \\' : null,
    `  ${defaults?.image || 'andreas404/insightd-agent:latest'}`,
  ].filter(Boolean).join('\n');

  return (
    <div>
      <h2 className="text-xl font-bold mb-1 text-fg">Add Your First Agent</h2>
      <p className="mb-5 text-sm text-muted">Run this command on the host you want to monitor.</p>
      <div className="space-y-4">
        <FormField label="Host ID" description="A unique name for this host">
          <Input value={hostId} onChange={e => setHostId(e.target.value)} placeholder="e.g. nas-01, web-server" autoFocus />
        </FormField>
        <FormField label="Remote Updates">
          <Select value={allowUpdates ? '1' : '0'} onChange={e => setAllowUpdates(e.target.value === '1')}>
            <option value="1">Enabled</option>
            <option value="0">Disabled</option>
          </Select>
        </FormField>
        <CommandBlock command={command} />
        <div className="flex gap-3">
          <Button onClick={onNext}>I've Run the Command</Button>
          <Button variant="secondary" onClick={onSkip}>Skip</Button>
        </div>
      </div>
    </div>
  );
}

function useAgentSetup() {
  const [data, setData] = useState<AgentSetup | null>(null);
  useEffect(() => { api<AgentSetup>('/agent-setup').then(setData).catch(() => {}); }, []);
  return { data };
}

function WaitingStep({ mode, onNext, onSkip }: { mode: string; onNext: () => void; onSkip: () => void }) {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [containers, setContainers] = useState<ContainerSnapshot[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (mode === 'standalone') { onNext(); return; }

    const poll = setInterval(async () => {
      try {
        const h = await api<Host[]>('/hosts');
        setHosts(h);
        if (h.length > 0) {
          const c = await api<ContainerSnapshot[]>(`/hosts/${encodeURIComponent(h[0]!.host_id)}/containers?showInternal=true`);
          setContainers(c);
          setConnected(true);
          clearInterval(poll);
          setTimeout(onNext, 3000);
        }
      } catch { /* keep polling */ }
    }, 3000);

    return () => clearInterval(poll);
  }, [mode, onNext]);

  return (
    <div className="text-center">
      {!connected ? (
        <>
          <div className="mb-4 animate-pulse text-4xl">📡</div>
          <h2 className="text-xl font-bold mb-2 text-fg">Waiting for Agent</h2>
          <p className="mb-5 text-sm text-muted">Run the command from the previous step on your host...</p>
          <div className="h-1 w-48 mx-auto rounded-full overflow-hidden bg-border">
            <div className="h-full w-1/3 rounded-full bg-info animate-pulse" />
          </div>
        </>
      ) : (
        <>
          <div className="mb-4 text-4xl">🎉</div>
          <h2 className="text-xl font-bold mb-2 text-success">Agent Connected!</h2>
          <div className="space-y-2 text-sm text-secondary">
            <p>✓ {hosts[0]?.host_id} is online</p>
            <p>✓ {containers.length} containers found</p>
          </div>
        </>
      )}
      <div className="mt-6">
        <Button variant="secondary" onClick={onSkip}>Skip — I'll add agents later</Button>
      </div>
    </div>
  );
}

function DoneStep({ onComplete }: { onComplete: () => void }) {
  const finish = async () => {
    try { await fetch('/api/setup/complete', { method: 'POST' }); } catch { /* ignore */ }
    onComplete();
  };

  return (
    <div className="text-center">
      <div className="mb-4 text-4xl">🚀</div>
      <h2 className="text-2xl font-bold mb-2 text-fg">You're All Set!</h2>
      <p className="mb-6 text-sm text-muted">
        insightd is now monitoring your infrastructure. Data will start appearing on the dashboard within a few minutes.
      </p>
      <Button onClick={finish}>Go to Dashboard →</Button>
    </div>
  );
}
