import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { CommandBlock } from '@/components/CommandBlock';
import { Card } from '@/components/Card';
import type { WizardState, BrokerDefaults, AgentSetupCheck } from '../types';
import { buildDockerCommand } from '../builders/docker';
import { buildPveInstallCommand } from '../builders/pve';
import { buildK8sManifest } from '../builders/k8s';

export function Step4Install({ state }: { state: WizardState }) {
  const target = state.target!;
  const { data: defaults } = useQuery({
    queryKey: queryKeys.agentSetup(),
    queryFn: () => api<BrokerDefaults>('/agent-setup'),
    refetchInterval: false,
  });

  const broker = {
    url:  state.useDefaultBroker ? (defaults?.mqttUrl  ?? '') : state.mqttUrl,
    user: state.useDefaultBroker ? (defaults?.mqttUser ?? '') : state.mqttUser,
    pass: state.useDefaultBroker ? (defaults?.mqttPass ?? '') : state.mqttPass,
  };
  const image = state.advanced.image ?? defaults?.image ?? 'andreas404/insightd-agent:latest';

  let command = '';
  if (target === 'docker' || target === 'in-guest') {
    command = buildDockerCommand({
      identifier: state.identifier, broker, permissions: state.permissions,
      advanced: state.advanced, image,
    });
  } else if (target === 'pve') {
    command = buildPveInstallCommand({
      identifier: state.identifier, broker, permissions: state.permissions, advanced: state.advanced,
    });
  } else if (target === 'k8s') {
    command = buildK8sManifest({
      identifier: state.identifier, broker,
      permissions: { allowActions: state.permissions.allowActions },
      advanced: { collectInterval: state.advanced.collectInterval, tz: state.advanced.tz, diskWarnThreshold: state.advanced.diskWarnThreshold, image: state.advanced.image },
    });
  }

  const [skipPveLink, setSkipPveLink] = useState(false);
  const waitingForPveLink = target === 'in-guest' && !skipPveLink;

  const verify = useQuery({
    queryKey: queryKeys.agentSetupCheck(target, state.identifier),
    queryFn: () => api<AgentSetupCheck>(`/agent-setup/check?target=${encodeURIComponent(target)}&identifier=${encodeURIComponent(state.identifier)}`),
    refetchInterval: (q) => {
      const data = q.state.data as AgentSetupCheck | undefined;
      if (!data) return 2000;
      if (data.status !== 'connected') return 2000;
      if (waitingForPveLink && data.proxmoxLink === null) return 2000;
      return false;
    },
  });

  // Show "Skip auto-link check" link after the user has been waiting for PVE auto-link for ~60s.
  const [waitStart, setWaitStart] = useState<number | null>(null);
  useEffect(() => {
    if (target !== 'in-guest') { setWaitStart(null); return; }
    if (verify.data?.status === 'connected' && verify.data.proxmoxLink === null && waitStart === null) {
      setWaitStart(Date.now());
    }
    if (verify.data?.proxmoxLink !== null) setWaitStart(null);
  }, [target, verify.data, waitStart]);
  const showSkipLink = waitStart !== null && Date.now() - waitStart > 60_000;

  return (
    <div className="space-y-4">
      <Card title={`Install command (${target})`}>
        <CommandBlock command={command} />
        {target === 'in-guest' && (
          <p className="mt-2 text-xs text-muted">
            Auto-correlation to the PVE host completes within ~30s of first heartbeat.
          </p>
        )}
      </Card>
      <Card title="Verify">
        <VerifyPanel
          target={target}
          identifier={state.identifier}
          data={verify.data}
          waitingForPveLink={waitingForPveLink}
          onSkipLink={showSkipLink ? () => setSkipPveLink(true) : null}
        />
      </Card>
    </div>
  );
}

function VerifyPanel({
  target, identifier, data, waitingForPveLink, onSkipLink,
}: {
  target: NonNullable<WizardState['target']>;
  identifier: string;
  data: AgentSetupCheck | undefined;
  waitingForPveLink: boolean;
  onSkipLink: (() => void) | null;
}) {
  if (!data || data.status === 'waiting') {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-info" />
        Waiting for agent... First heartbeat usually arrives within 30s.
      </div>
    );
  }
  // status === 'connected'
  if (target === 'in-guest' && waitingForPveLink && data.proxmoxLink === null) {
    return (
      <div className="space-y-2 text-sm">
        <div>✓ Connected. Waiting for PVE auto-link...</div>
        {onSkipLink && (
          <button type="button" onClick={onSkipLink} className="text-xs text-info hover:underline">
            Skip auto-link check
          </button>
        )}
      </div>
    );
  }
  if (target === 'in-guest' && data.proxmoxLink) {
    return (
      <div className="text-sm">
        ✓ Connected and auto-linked to <strong>{data.proxmoxLink.node}</strong> /
        VMID <strong>{data.proxmoxLink.vmid}</strong> ({data.proxmoxLink.guestType}).{' '}
        <Link to={`/hosts/${encodeURIComponent(identifier)}`} className="text-info hover:underline">→ View host page</Link>
      </div>
    );
  }
  if (target === 'pve') {
    return (
      <div className="text-sm">
        ✓ Connected. {data.pveCluster ? <>Cluster: <strong>{data.pveCluster}</strong>.</> : 'Standalone PVE.'}{' '}
        <Link to={`/hosts/${encodeURIComponent(identifier)}`} className="text-info hover:underline">→ View host page</Link>
      </div>
    );
  }
  if (target === 'k8s') {
    return (
      <div className="text-sm">
        ✓ Connected. At least one node has joined the cluster.{' '}
        <Link to="/hosts" className="text-info hover:underline">→ View Hosts page</Link>
      </div>
    );
  }
  // docker
  return (
    <div className="text-sm">
      ✓ Connected. Last heartbeat: just now.{' '}
      <Link to={`/hosts/${encodeURIComponent(identifier)}`} className="text-info hover:underline">→ View host page</Link>
    </div>
  );
}
