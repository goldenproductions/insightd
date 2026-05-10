import type { WizardState, Target } from '../types';

const TARGETS: Array<{ id: Target; icon: string; title: string; sub: string; bullets: string[] }> = [
  { id: 'docker',   icon: '🐳', title: 'Docker host',     sub: 'Linux/macOS box with Docker installed.',         bullets: ['Container metrics', 'Updates + actions'] },
  { id: 'k8s',      icon: '☸',  title: 'Kubernetes',      sub: 'DaemonSet — one agent per cluster node.',         bullets: ['Pod inventory', 'PV/PVC + events'] },
  { id: 'pve',      icon: '🖥', title: 'Proxmox VE',      sub: 'PVE bare-metal install via curl-pipe-bash.',     bullets: ['Guest inventory', 'ZFS, backups, quorum'] },
  { id: 'in-guest', icon: '📦', title: 'In-guest agent',  sub: 'Inside a PVE VM or LXC.',                         bullets: ['Auto-correlates to its PVE host'] },
];

export function Step1Target({ state, setState }: { state: WizardState; setState: (u: (s: WizardState) => WizardState) => void }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">Where will this agent run?</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {TARGETS.map(t => {
          const selected = state.target === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setState(s => ({ ...s, target: t.id }))}
              className={[
                'flex flex-col gap-2 rounded-lg border p-4 text-left transition',
                selected ? 'border-info bg-info/10' : 'border-border bg-surface hover:border-info/50',
              ].join(' ')}
              aria-pressed={selected}
            >
              <div className="flex items-center gap-3">
                <span className="text-2xl">{t.icon}</span>
                <span className="font-semibold">{t.title}</span>
              </div>
              <p className="text-xs text-muted">{t.sub}</p>
              <ul className="mt-1 space-y-0.5 text-xs text-secondary">
                {t.bullets.map(b => <li key={b}>• {b}</li>)}
              </ul>
            </button>
          );
        })}
      </div>
    </div>
  );
}
