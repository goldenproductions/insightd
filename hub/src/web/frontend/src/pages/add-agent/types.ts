export type Target = 'docker' | 'k8s' | 'pve' | 'in-guest';

export interface WizardState {
  target: Target | null;
  identifier: string;
  useDefaultBroker: boolean;
  mqttUrl: string;
  mqttUser: string;
  mqttPass: string;
  permissions: { allowUpdates: boolean; allowActions: boolean };
  advancedOpen: boolean;
  advanced: {
    collectInterval?: string;
    updateCheckCron?: string;
    tz?: string;
    diskWarnThreshold?: string;
    logLines?: string;
    logMaxLines?: string;
    image?: string;
  };
}

export interface BrokerDefaults {
  mqttUrl: string;
  mqttUser: string;
  mqttPass: string;
  image: string;
}

export interface AgentSetupCheck {
  status: 'waiting' | 'connected';
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  proxmoxLink: { node: string; vmid: number; guestType: 'qemu' | 'lxc' } | null;
  pveCluster: string | null;
}

export const initialWizardState: WizardState = {
  target: null,
  identifier: '',
  useDefaultBroker: true,
  mqttUrl: '',
  mqttUser: '',
  mqttPass: '',
  permissions: { allowUpdates: true, allowActions: true },
  advancedOpen: false,
  advanced: {},
};
