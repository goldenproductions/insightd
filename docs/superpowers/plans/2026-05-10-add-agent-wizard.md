# Add Agent Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat `AddAgentPage` with a 4-step wizard that covers four deployment targets (Docker / Kubernetes / Proxmox VE / in-guest agent on PVE), shows smart defaults with an Advanced disclosure, and live-verifies that the agent connected after install.

**Architecture:** New `pages/add-agent/` directory with a wizard shell holding `WizardState` in `useState`, four step components, three target-specific command builders, and a shared types file. Backend gains one new read-only `GET /api/agent-setup/check` endpoint inside `hub/src/web/handlers.ts` for the live-verify polling.

**Tech Stack:** React 19 + TypeScript (strict), Vite 6, TanStack Query v5, Tailwind v4. Backend: Node.js + better-sqlite3. Tests: `node:test` + `tsx`.

**Spec:** [docs/superpowers/specs/2026-05-10-add-agent-wizard-design.md](../specs/2026-05-10-add-agent-wizard-design.md)

---

## File Structure

**Created:**
- `hub/src/web/frontend/src/pages/add-agent/AddAgentPage.tsx` — wizard shell (stepper, footer, state container)
- `hub/src/web/frontend/src/pages/add-agent/types.ts` — `Target`, `WizardState`, `AgentSetupCheck`
- `hub/src/web/frontend/src/pages/add-agent/steps/Step1Target.tsx` — 4-card target picker
- `hub/src/web/frontend/src/pages/add-agent/steps/Step2Connection.tsx` — identifier + MQTT broker fields
- `hub/src/web/frontend/src/pages/add-agent/steps/Step3Options.tsx` — permissions + Advanced disclosure
- `hub/src/web/frontend/src/pages/add-agent/steps/Step4Install.tsx` — install command + verify panel
- `hub/src/web/frontend/src/pages/add-agent/builders/docker.ts` — `buildDockerCommand(state): string`
- `hub/src/web/frontend/src/pages/add-agent/builders/k8s.ts` — `buildK8sManifest(state): string`
- `hub/src/web/frontend/src/pages/add-agent/builders/pve.ts` — `buildPveInstallCommand(state): string`
- `tests/unit/builder-docker.test.ts`
- `tests/unit/builder-k8s.test.ts`
- `tests/unit/builder-pve.test.ts`
- `tests/unit/handler-agent-setup-check.test.ts`

**Modified:**
- `hub/src/web/handlers.ts` — add `handleAgentSetupCheck` next to `handleAgentSetup`; export from `module.exports`
- `hub/src/web/server.ts` — register `GET /api/agent-setup/check`
- `hub/src/web/frontend/src/App.tsx` — change lazy import path from `@/pages/AddAgentPage` to `@/pages/add-agent/AddAgentPage`
- `hub/src/web/frontend/src/lib/queryKeys.ts` — add `agentSetupCheck: (target, identifier) => [...]`

**Deleted:**
- `hub/src/web/frontend/src/pages/AddAgentPage.tsx` (149 lines)

**No changes to:** schema, MQTT layer, existing `/api/agent-setup` payload, agent code, k8s manifest source files (they remain as-is in `agent/k8s/` for non-wizard install paths).

---

## Task 1: Backend `/api/agent-setup/check` endpoint

**Files:**
- Test: `tests/unit/handler-agent-setup-check.test.ts` (create)
- Modify: `hub/src/web/handlers.ts` (add function near `handleAgentSetup` at line ~488; add to `module.exports` at line ~1574)
- Modify: `hub/src/web/server.ts` (register route near line 107)

- [ ] **Step 1: Write the failing test file**

Create `tests/unit/handler-agent-setup-check.test.ts`:

```ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerResponse, IncomingMessage } from 'node:http';
const { createTestDb } = require('../helpers/db');
const { handleAgentSetupCheck } = require('../../hub/src/web/handlers');

function fakeReq(url: string): IncomingMessage {
  return { url, headers: { host: 'localhost' } } as unknown as IncomingMessage;
}
const fakeRes = {} as ServerResponse;
const cfg = {};

interface Result {
  status: 'waiting' | 'connected';
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  proxmoxLink: { node: string; vmid: number; guestType: 'qemu' | 'lxc' } | null;
  pveCluster: string | null;
}

describe('handleAgentSetupCheck', () => {
  let db: any;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('returns waiting when no host row exists (target=docker)', () => {
    const r = handleAgentSetupCheck(fakeReq('/api/agent-setup/check?identifier=nas-01&target=docker'), fakeRes, db, cfg) as Result;
    assert.equal(r.status, 'waiting');
    assert.equal(r.firstSeenAt, null);
    assert.equal(r.proxmoxLink, null);
    assert.equal(r.pveCluster, null);
  });

  it('returns connected when host row exists (target=docker)', () => {
    db.prepare(`INSERT INTO hosts (host_id, first_seen, last_seen, runtime_type) VALUES ('nas-01', '2026-05-10T00:00:00Z', '2026-05-10T00:00:30Z', 'docker')`).run();
    const r = handleAgentSetupCheck(fakeReq('/api/agent-setup/check?identifier=nas-01&target=docker'), fakeRes, db, cfg) as Result;
    assert.equal(r.status, 'connected');
    assert.equal(r.firstSeenAt, '2026-05-10T00:00:00Z');
    assert.equal(r.lastSeenAt, '2026-05-10T00:00:30Z');
  });

  it('populates proxmoxLink for in-guest target when host has proxmox_* set', () => {
    db.prepare(`INSERT INTO hosts (host_id, first_seen, last_seen, runtime_type, proxmox_node, proxmox_vmid, proxmox_guest_type, proxmox_cluster_id)
                VALUES ('n8n-vm', 't1', 't2', 'docker', 'proxmox-01', 108, 'qemu', 'homelab')`).run();
    const r = handleAgentSetupCheck(fakeReq('/api/agent-setup/check?identifier=n8n-vm&target=in-guest'), fakeRes, db, cfg) as Result;
    assert.equal(r.status, 'connected');
    assert.deepEqual(r.proxmoxLink, { node: 'proxmox-01', vmid: 108, guestType: 'qemu' });
  });

  it('returns proxmoxLink=null for in-guest target when host has no PVE link yet', () => {
    db.prepare(`INSERT INTO hosts (host_id, first_seen, last_seen, runtime_type) VALUES ('n8n-vm', 't1', 't2', 'docker')`).run();
    const r = handleAgentSetupCheck(fakeReq('/api/agent-setup/check?identifier=n8n-vm&target=in-guest'), fakeRes, db, cfg) as Result;
    assert.equal(r.status, 'connected');
    assert.equal(r.proxmoxLink, null);
  });

  it('populates pveCluster for pve target when proxmox_cluster_id matches a pve_cluster_status row', () => {
    db.prepare(`INSERT INTO hosts (host_id, first_seen, last_seen, runtime_type, proxmox_cluster_id) VALUES ('proxmox-01', 't1', 't2', 'docker', 'homelab')`).run();
    db.prepare(`INSERT INTO pve_cluster_status (cluster_name, quorate, total_nodes, online_nodes) VALUES ('homelab', 1, 3, 3)`).run();
    const r = handleAgentSetupCheck(fakeReq('/api/agent-setup/check?identifier=proxmox-01&target=pve'), fakeRes, db, cfg) as Result;
    assert.equal(r.status, 'connected');
    assert.equal(r.pveCluster, 'homelab');
  });

  it('returns pveCluster=null for pve target on standalone PVE (no pve_cluster_status row)', () => {
    db.prepare(`INSERT INTO hosts (host_id, first_seen, last_seen, runtime_type) VALUES ('standalone-pve', 't1', 't2', 'docker')`).run();
    const r = handleAgentSetupCheck(fakeReq('/api/agent-setup/check?identifier=standalone-pve&target=pve'), fakeRes, db, cfg) as Result;
    assert.equal(r.status, 'connected');
    assert.equal(r.pveCluster, null);
  });

  it('returns connected when at least one k8s host has matching host_group (target=k8s)', () => {
    db.prepare(`INSERT INTO hosts (host_id, first_seen, last_seen, runtime_type, host_group) VALUES ('node-1', 't1', 't2', 'kubernetes', 'homelab-k3s')`).run();
    const r = handleAgentSetupCheck(fakeReq('/api/agent-setup/check?identifier=homelab-k3s&target=k8s'), fakeRes, db, cfg) as Result;
    assert.equal(r.status, 'connected');
  });

  it('returns waiting for k8s when only non-k8s hosts share the host_group label', () => {
    db.prepare(`INSERT INTO hosts (host_id, first_seen, last_seen, runtime_type, host_group) VALUES ('docker-host', 't1', 't2', 'docker', 'homelab')`).run();
    const r = handleAgentSetupCheck(fakeReq('/api/agent-setup/check?identifier=homelab&target=k8s'), fakeRes, db, cfg) as Result;
    assert.equal(r.status, 'waiting');
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `npx tsx --test tests/unit/handler-agent-setup-check.test.ts`

Expected: FAIL with `TypeError: handleAgentSetupCheck is not a function` (or similar — the export does not exist).

- [ ] **Step 3: Add the handler in `hub/src/web/handlers.ts`**

Insert after the existing `handleAgentSetup` function (around line 496):

```ts
function handleAgentSetupCheck(req: HandlerReq, res: ServerResponse, db: Database.Database, _config: any): any {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const identifier = (url.searchParams.get('identifier') || '').trim();
  const target = (url.searchParams.get('target') || '').trim();

  if (!identifier || !['docker', 'k8s', 'pve', 'in-guest'].includes(target)) {
    return { status: 'waiting', firstSeenAt: null, lastSeenAt: null, proxmoxLink: null, pveCluster: null };
  }

  if (target === 'k8s') {
    const row = db.prepare(`SELECT 1 AS hit FROM hosts WHERE host_group = ? AND runtime_type = 'kubernetes' LIMIT 1`).get(identifier) as { hit: number } | undefined;
    return {
      status: row ? 'connected' : 'waiting',
      firstSeenAt: null,
      lastSeenAt: null,
      proxmoxLink: null,
      pveCluster: null,
    };
  }

  const host = db.prepare(`
    SELECT host_id, first_seen, last_seen,
           proxmox_node, proxmox_vmid, proxmox_guest_type, proxmox_cluster_id
      FROM hosts
     WHERE host_id = ?
  `).get(identifier) as
    | { host_id: string; first_seen: string; last_seen: string;
        proxmox_node: string | null; proxmox_vmid: number | null;
        proxmox_guest_type: 'qemu' | 'lxc' | null; proxmox_cluster_id: string | null }
    | undefined;

  if (!host) {
    return { status: 'waiting', firstSeenAt: null, lastSeenAt: null, proxmoxLink: null, pveCluster: null };
  }

  const proxmoxLink = (target === 'in-guest' && host.proxmox_vmid != null && host.proxmox_node && host.proxmox_guest_type)
    ? { node: host.proxmox_node, vmid: host.proxmox_vmid, guestType: host.proxmox_guest_type }
    : null;

  let pveCluster: string | null = null;
  if (target === 'pve' && host.proxmox_cluster_id) {
    const cluster = db.prepare(`SELECT cluster_name FROM pve_cluster_status WHERE cluster_name = ?`)
      .get(host.proxmox_cluster_id) as { cluster_name: string } | undefined;
    pveCluster = cluster?.cluster_name ?? null;
  }

  return {
    status: 'connected',
    firstSeenAt: host.first_seen,
    lastSeenAt: host.last_seen,
    proxmoxLink,
    pveCluster,
  };
}
```

- [ ] **Step 4: Add `handleAgentSetupCheck` to `module.exports`**

In `hub/src/web/handlers.ts` line ~1574, append `, handleAgentSetupCheck` to the exports object literal so the test can `require` it:

```ts
module.exports = { ..., handleAgentSetup, handleAgentSetupCheck, ... };
```

(Insert right after `handleAgentSetup`. Keep the rest of the list unchanged.)

- [ ] **Step 5: Register the route in `hub/src/web/server.ts`**

Find the line registering `/api/agent-setup` (line 107) and add the new route immediately after:

```ts
router.add('GET', '/api/agent-setup', handlers.handleAgentSetup);
router.add('GET', '/api/agent-setup/check', handlers.handleAgentSetupCheck);
```

- [ ] **Step 6: Run the new test — should PASS**

Run: `npx tsx --test tests/unit/handler-agent-setup-check.test.ts`

Expected: all 8 subtests pass.

- [ ] **Step 7: Run the full suite + typecheck**

Run in parallel:
```bash
npm test
npm run typecheck
```

Expected: full suite green, typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add hub/src/web/handlers.ts hub/src/web/server.ts tests/unit/handler-agent-setup-check.test.ts
git commit -m "feat(api): GET /api/agent-setup/check for wizard live-verify"
```

---

## Task 2: Frontend types + three command builders

**Files:**
- Create: `hub/src/web/frontend/src/pages/add-agent/types.ts`
- Create: `hub/src/web/frontend/src/pages/add-agent/builders/docker.ts`
- Create: `hub/src/web/frontend/src/pages/add-agent/builders/k8s.ts`
- Create: `hub/src/web/frontend/src/pages/add-agent/builders/pve.ts`
- Create: `tests/unit/builder-docker.test.ts`
- Create: `tests/unit/builder-k8s.test.ts`
- Create: `tests/unit/builder-pve.test.ts`

- [ ] **Step 1: Create the types file**

Create `hub/src/web/frontend/src/pages/add-agent/types.ts`:

```ts
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
```

- [ ] **Step 2: Write the failing builder-docker test**

Create `tests/unit/builder-docker.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
const { buildDockerCommand } = require('../../hub/src/web/frontend/src/pages/add-agent/builders/docker');

interface Inputs { identifier: string; broker: { url: string; user?: string; pass?: string };
                   permissions: { allowUpdates: boolean; allowActions: boolean };
                   advanced: Record<string, string | undefined>;
                   image: string; }

function defaults(over: Partial<Inputs> = {}): Inputs {
  return {
    identifier: 'nas-01',
    broker: { url: 'mqtt://hub:1883' },
    permissions: { allowUpdates: true, allowActions: true },
    advanced: {},
    image: 'andreas404/insightd-agent:latest',
    ...over,
  };
}

describe('buildDockerCommand', () => {
  it('emits a default docker run with required env vars', () => {
    const out = buildDockerCommand(defaults());
    assert.match(out, /docker run -d/);
    assert.match(out, /--name insightd-agent/);
    assert.match(out, /-e INSIGHTD_HOST_ID=nas-01/);
    assert.match(out, /-e INSIGHTD_MQTT_URL=mqtt:\/\/hub:1883/);
    assert.match(out, /-e INSIGHTD_ALLOW_UPDATES=true/);
    assert.match(out, /-e INSIGHTD_ALLOW_ACTIONS=true/);
    assert.match(out, /andreas404\/insightd-agent:latest/);
  });

  it('mounts the docker socket read-only when allow_updates=false', () => {
    const out = buildDockerCommand(defaults({ permissions: { allowUpdates: false, allowActions: true } }));
    assert.match(out, /\/var\/run\/docker\.sock:\/var\/run\/docker\.sock:ro/);
    assert.doesNotMatch(out, /-e INSIGHTD_ALLOW_UPDATES=true/);
  });

  it('omits ALLOW_ACTIONS when false (only non-default values are emitted)', () => {
    const out = buildDockerCommand(defaults({ permissions: { allowUpdates: true, allowActions: false } }));
    assert.doesNotMatch(out, /-e INSIGHTD_ALLOW_ACTIONS=true/);
  });

  it('emits MQTT user/pass only when set', () => {
    const out = buildDockerCommand(defaults({ broker: { url: 'mqtt://hub:1883', user: 'agent', pass: 'sec' } }));
    assert.match(out, /-e INSIGHTD_MQTT_USER=agent/);
    assert.match(out, /-e INSIGHTD_MQTT_PASS=sec/);
  });

  it('emits advanced env only when set and != default', () => {
    const out = buildDockerCommand(defaults({ advanced: { collectInterval: '10', tz: 'Europe/Oslo' } }));
    assert.match(out, /-e INSIGHTD_COLLECT_INTERVAL=10/);
    assert.match(out, /-e TZ=Europe\/Oslo/);
    assert.doesNotMatch(out, /-e INSIGHTD_LOG_LINES/);
  });

  it('uses provided image override', () => {
    const out = buildDockerCommand(defaults({ image: 'andreas404/insightd-agent:hub-v1.0.0' }));
    assert.match(out, /andreas404\/insightd-agent:hub-v1\.0\.0/);
  });
});
```

- [ ] **Step 3: Run docker builder test — verify it fails**

Run: `npx tsx --test tests/unit/builder-docker.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 4: Implement `builders/docker.ts`**

Create `hub/src/web/frontend/src/pages/add-agent/builders/docker.ts`:

```ts
export interface DockerCommandInputs {
  identifier: string;
  broker: { url: string; user?: string; pass?: string };
  permissions: { allowUpdates: boolean; allowActions: boolean };
  advanced: {
    collectInterval?: string;
    updateCheckCron?: string;
    tz?: string;
    diskWarnThreshold?: string;
    logLines?: string;
    logMaxLines?: string;
  };
  image: string;
}

export function buildDockerCommand(i: DockerCommandInputs): string {
  const { identifier, broker, permissions: p, advanced: a, image } = i;
  const socketMount = `/var/run/docker.sock:/var/run/docker.sock${p.allowUpdates ? '' : ':ro'}`;
  const lines: (string | null)[] = [
    `  -e INSIGHTD_HOST_ID=${identifier} \\`,
    `  -e INSIGHTD_MQTT_URL=${broker.url} \\`,
    broker.user        ? `  -e INSIGHTD_MQTT_USER=${broker.user} \\` : null,
    broker.pass        ? `  -e INSIGHTD_MQTT_PASS=${broker.pass} \\` : null,
    p.allowUpdates     ? '  -e INSIGHTD_ALLOW_UPDATES=true \\' : null,
    p.allowActions     ? '  -e INSIGHTD_ALLOW_ACTIONS=true \\' : null,
    advancedLine('INSIGHTD_COLLECT_INTERVAL', a.collectInterval, '5'),
    advancedLine('INSIGHTD_UPDATE_CHECK_CRON', a.updateCheckCron, '0 3 * * *', { quote: true }),
    advancedLine('TZ',                          a.tz,             'UTC'),
    advancedLine('INSIGHTD_DISK_WARN_THRESHOLD', a.diskWarnThreshold, '85'),
    advancedLine('INSIGHTD_LOG_LINES',           a.logLines,        '100'),
    advancedLine('INSIGHTD_LOG_MAX_LINES',       a.logMaxLines,     '1000'),
  ];
  return [
    'docker run -d \\',
    '  --name insightd-agent \\',
    '  --restart unless-stopped \\',
    `  -v ${socketMount} \\`,
    '  -v /:/host:ro \\',
    ...lines.filter(Boolean),
    `  ${image}`,
  ].join('\n');
}

function advancedLine(name: string, value: string | undefined, defaultValue: string, opts: { quote?: boolean } = {}): string | null {
  if (!value || value === defaultValue) return null;
  const v = opts.quote ? `"${value}"` : value;
  return `  -e ${name}=${v} \\`;
}
```

- [ ] **Step 5: Run docker builder test — should PASS**

Run: `npx tsx --test tests/unit/builder-docker.test.ts`

Expected: all 6 tests pass.

- [ ] **Step 6: Write the failing builder-pve test**

Create `tests/unit/builder-pve.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
const { buildPveInstallCommand } = require('../../hub/src/web/frontend/src/pages/add-agent/builders/pve');

describe('buildPveInstallCommand', () => {
  it('emits a curl-pipe-bash one-liner with required env vars', () => {
    const out = buildPveInstallCommand({
      identifier: 'proxmox-01',
      broker: { url: 'mqtt://hub:1883' },
      permissions: { allowUpdates: true, allowActions: true },
      advanced: {},
    });
    assert.match(out, /curl -fsSL https:\/\/get\.insightd\.org\/install/);
    assert.match(out, /INSIGHTD_HOST_ID=proxmox-01/);
    assert.match(out, /INSIGHTD_MQTT_URL=mqtt:\/\/hub:1883/);
    assert.match(out, /INSIGHTD_ALLOW_UPDATES=true/);
    assert.match(out, /\| bash$/);
  });

  it('omits MQTT_USER and MQTT_PASS when not provided', () => {
    const out = buildPveInstallCommand({
      identifier: 'proxmox-01',
      broker: { url: 'mqtt://hub:1883' },
      permissions: { allowUpdates: true, allowActions: true },
      advanced: {},
    });
    assert.doesNotMatch(out, /INSIGHTD_MQTT_USER/);
    assert.doesNotMatch(out, /INSIGHTD_MQTT_PASS/);
  });

  it('omits advanced field when value equals default', () => {
    const out = buildPveInstallCommand({
      identifier: 'proxmox-01',
      broker: { url: 'mqtt://hub:1883' },
      permissions: { allowUpdates: true, allowActions: true },
      advanced: { updateCheckCron: '0 3 * * *' },
    });
    assert.doesNotMatch(out, /INSIGHTD_UPDATE_CHECK_CRON/);
  });

  it('quotes advanced values that contain whitespace', () => {
    const out = buildPveInstallCommand({
      identifier: 'proxmox-01',
      broker: { url: 'mqtt://hub:1883' },
      permissions: { allowUpdates: true, allowActions: true },
      advanced: { updateCheckCron: '*/15 * * * *' },
    });
    assert.match(out, /INSIGHTD_UPDATE_CHECK_CRON="\*\/15 \* \* \* \*"/);
  });
});
```

- [ ] **Step 7: Implement `builders/pve.ts`**

Create `hub/src/web/frontend/src/pages/add-agent/builders/pve.ts`:

```ts
export interface PveCommandInputs {
  identifier: string;
  broker: { url: string; user?: string; pass?: string };
  permissions: { allowUpdates: boolean; allowActions: boolean };
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

export function buildPveInstallCommand(i: PveCommandInputs): string {
  const { identifier, broker, permissions: p, advanced: a } = i;
  const envs: string[] = [
    `INSIGHTD_HOST_ID=${identifier}`,
    `INSIGHTD_MQTT_URL=${broker.url}`,
  ];
  if (broker.user) envs.push(`INSIGHTD_MQTT_USER=${broker.user}`);
  if (broker.pass) envs.push(`INSIGHTD_MQTT_PASS=${broker.pass}`);
  if (p.allowUpdates) envs.push('INSIGHTD_ALLOW_UPDATES=true');
  if (p.allowActions) envs.push('INSIGHTD_ALLOW_ACTIONS=true');
  pushAdvanced(envs, 'INSIGHTD_COLLECT_INTERVAL',  a.collectInterval,  '5');
  pushAdvanced(envs, 'INSIGHTD_UPDATE_CHECK_CRON', a.updateCheckCron, '0 3 * * *');
  pushAdvanced(envs, 'TZ',                          a.tz,              'UTC');
  pushAdvanced(envs, 'INSIGHTD_DISK_WARN_THRESHOLD', a.diskWarnThreshold, '85');
  pushAdvanced(envs, 'INSIGHTD_LOG_LINES',           a.logLines,        '100');
  pushAdvanced(envs, 'INSIGHTD_LOG_MAX_LINES',       a.logMaxLines,     '1000');
  if (a.image) envs.push(`INSIGHTD_IMAGE=${a.image}`);
  return `curl -fsSL https://get.insightd.org/install | ${envs.join(' ')} bash`;
}

function pushAdvanced(envs: string[], name: string, value: string | undefined, defaultValue: string): void {
  if (!value || value === defaultValue) return;
  const needsQuoting = /\s/.test(value);
  envs.push(needsQuoting ? `${name}="${value}"` : `${name}=${value}`);
}
```

- [ ] **Step 8: Run pve builder test — should PASS**

Run: `npx tsx --test tests/unit/builder-pve.test.ts`

Expected: all 3 tests pass.

- [ ] **Step 9: Write the failing builder-k8s test**

Create `tests/unit/builder-k8s.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
const { buildK8sManifest } = require('../../hub/src/web/frontend/src/pages/add-agent/builders/k8s');

describe('buildK8sManifest', () => {
  it('emits a kubectl apply heredoc containing DaemonSet + RBAC', () => {
    const out = buildK8sManifest({
      identifier: 'homelab-k3s',
      broker: { url: 'mqtt://hub:1883' },
      permissions: { allowActions: true },
      advanced: {},
    });
    assert.match(out, /kubectl apply -f -/);
    assert.match(out, /<<EOF/);
    assert.match(out, /\nEOF$/);
    assert.match(out, /kind: DaemonSet/);
    assert.match(out, /kind: ServiceAccount/);
    assert.match(out, /kind: ClusterRole/);
    assert.match(out, /kind: ClusterRoleBinding/);
  });

  it('substitutes the cluster name into INSIGHTD_HOST_GROUP env', () => {
    const out = buildK8sManifest({
      identifier: 'homelab-k3s',
      broker: { url: 'mqtt://hub:1883' },
      permissions: { allowActions: true },
      advanced: {},
    });
    assert.match(out, /name: INSIGHTD_HOST_GROUP\s*\n\s*value: homelab-k3s/);
  });

  it('substitutes broker URL', () => {
    const out = buildK8sManifest({
      identifier: 'homelab-k3s',
      broker: { url: 'mqtt://my-broker:1883' },
      permissions: { allowActions: true },
      advanced: {},
    });
    assert.match(out, /name: INSIGHTD_MQTT_URL\s*\n\s*value: mqtt:\/\/my-broker:1883/);
  });

  it('emits ALLOW_ACTIONS only when permissions.allowActions=true', () => {
    const on = buildK8sManifest({
      identifier: 'c', broker: { url: 'mqtt://h:1883' },
      permissions: { allowActions: true }, advanced: {},
    });
    const off = buildK8sManifest({
      identifier: 'c', broker: { url: 'mqtt://h:1883' },
      permissions: { allowActions: false }, advanced: {},
    });
    assert.match(on,  /name: INSIGHTD_ALLOW_ACTIONS\s*\n\s*value: ['"]true['"]/);
    assert.doesNotMatch(off, /INSIGHTD_ALLOW_ACTIONS/);
  });

  it('uses provided image override', () => {
    const out = buildK8sManifest({
      identifier: 'c', broker: { url: 'mqtt://h:1883' },
      permissions: { allowActions: true },
      advanced: { image: 'andreas404/insightd-agent:hub-v1.0.0' },
    });
    assert.match(out, /image: andreas404\/insightd-agent:hub-v1\.0\.0/);
  });

  it('emits collectInterval / tz / diskWarnThreshold only when set and != default', () => {
    const out = buildK8sManifest({
      identifier: 'c', broker: { url: 'mqtt://h:1883' },
      permissions: { allowActions: true },
      advanced: { collectInterval: '15', tz: 'Europe/Oslo' },
    });
    assert.match(out, /name: INSIGHTD_COLLECT_INTERVAL\s*\n\s*value: ['"]15['"]/);
    assert.match(out, /name: TZ\s*\n\s*value: Europe\/Oslo/);
    assert.doesNotMatch(out, /INSIGHTD_DISK_WARN_THRESHOLD/);
  });
});
```

- [ ] **Step 10: Implement `builders/k8s.ts`**

Create `hub/src/web/frontend/src/pages/add-agent/builders/k8s.ts`:

```ts
export interface K8sCommandInputs {
  identifier: string;                                // cluster name → INSIGHTD_HOST_GROUP
  broker: { url: string; user?: string; pass?: string };
  permissions: { allowActions: boolean };
  advanced: {
    collectInterval?: string;
    tz?: string;
    diskWarnThreshold?: string;
    image?: string;
  };
}

export function buildK8sManifest(i: K8sCommandInputs): string {
  const { identifier, broker, permissions: p, advanced: a } = i;
  const image = a.image ?? 'andreas404/insightd-agent:latest';

  const extraEnv: string[] = [];
  if (broker.user) extraEnv.push(envLiteral('INSIGHTD_MQTT_USER', broker.user));
  if (broker.pass) extraEnv.push(envLiteral('INSIGHTD_MQTT_PASS', broker.pass));
  if (p.allowActions) extraEnv.push(envLiteral('INSIGHTD_ALLOW_ACTIONS', 'true', { quote: true }));
  if (a.collectInterval && a.collectInterval !== '5')
    extraEnv.push(envLiteral('INSIGHTD_COLLECT_INTERVAL', a.collectInterval, { quote: true }));
  if (a.tz && a.tz !== 'UTC')
    extraEnv.push(envLiteral('TZ', a.tz));
  if (a.diskWarnThreshold && a.diskWarnThreshold !== '85')
    extraEnv.push(envLiteral('INSIGHTD_DISK_WARN_THRESHOLD', a.diskWarnThreshold, { quote: true }));

  const manifest = `---
apiVersion: v1
kind: Namespace
metadata:
  name: insightd
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: insightd-agent
  namespace: insightd
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: insightd-agent
rules:
  - apiGroups: [""]
    resources: ["nodes", "nodes/stats", "nodes/proxy", "pods", "events", "persistentvolumes", "persistentvolumeclaims", "services"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["deployments", "daemonsets", "statefulsets", "replicasets"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["batch"]
    resources: ["jobs", "cronjobs"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["networking.k8s.io"]
    resources: ["ingresses"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: insightd-agent
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: insightd-agent
subjects:
  - kind: ServiceAccount
    name: insightd-agent
    namespace: insightd
---
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: insightd-agent
  namespace: insightd
spec:
  selector:
    matchLabels:
      app: insightd-agent
  template:
    metadata:
      labels:
        app: insightd-agent
    spec:
      serviceAccountName: insightd-agent
      tolerations:
        - operator: Exists
      containers:
        - name: agent
          image: ${image}
          imagePullPolicy: Always
          env:
            - name: INSIGHTD_RUNTIME
              value: kubernetes
            - name: NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
            - name: NODE_IP
              valueFrom:
                fieldRef:
                  fieldPath: status.hostIP
            - name: INSIGHTD_HOST_ID
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
            - name: INSIGHTD_HOST_GROUP
              value: ${identifier}
            - name: INSIGHTD_MQTT_URL
              value: ${broker.url}
${extraEnv.map(s => '            ' + s.replace(/\n/g, '\n            ')).join('\n')}
EOF`;

  return `kubectl apply -f - <<EOF
${manifest}`;
}

function envLiteral(name: string, value: string, opts: { quote?: boolean } = {}): string {
  const v = opts.quote ? `"${value}"` : value;
  return `- name: ${name}\n  value: ${v}`;
}
```

- [ ] **Step 11: Run k8s builder test — should PASS**

Run: `npx tsx --test tests/unit/builder-k8s.test.ts`

Expected: all 6 tests pass.

- [ ] **Step 12: Run full test suite + typecheck**

```bash
npm test
npm run typecheck
```

Expected: full suite green, typecheck clean.

- [ ] **Step 13: Commit**

```bash
git add hub/src/web/frontend/src/pages/add-agent/types.ts \
        hub/src/web/frontend/src/pages/add-agent/builders \
        tests/unit/builder-docker.test.ts \
        tests/unit/builder-pve.test.ts \
        tests/unit/builder-k8s.test.ts
git commit -m "feat(frontend): add-agent wizard types + 3 target builders"
```

---

## Task 3: Wizard shell + Step 1 (Target picker)

**Files:**
- Create: `hub/src/web/frontend/src/pages/add-agent/AddAgentPage.tsx`
- Create: `hub/src/web/frontend/src/pages/add-agent/steps/Step1Target.tsx`

(Frontend components do not have unit tests in this codebase — the existing `tests/unit/` is backend-only. Validation is via manual UX test in Task 6 plus typecheck/build.)

- [ ] **Step 1: Create the wizard shell**

Create `hub/src/web/frontend/src/pages/add-agent/AddAgentPage.tsx`:

```tsx
import { useState } from 'react';
import { PageTitle } from '@/components/PageTitle';
import { Button } from '@/components/FormField';
import type { WizardState } from './types';
import { initialWizardState } from './types';
import { Step1Target } from './steps/Step1Target';

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
        {step === 2 && <PlaceholderStep label="Connection (Step 2 — Task 4)" />}
        {step === 3 && <PlaceholderStep label="Options (Step 3 — Task 4)" />}
        {step === 4 && <PlaceholderStep label="Install (Step 4 — Task 5)" />}
      </div>
      <div className="flex justify-between">
        <Button variant="secondary" onClick={() => setStep(s => Math.max(1, s - 1) as 1|2|3|4)} disabled={step === 1}>
          ← Back
        </Button>
        <Button onClick={() => setStep(s => Math.min(4, s + 1) as 1|2|3|4)} disabled={!canAdvance || step === 4}>
          Next →
        </Button>
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

function PlaceholderStep({ label }: { label: string }) {
  return <div className="rounded border border-border bg-surface p-4 text-muted">{label}</div>;
}
```

- [ ] **Step 2: Create `Step1Target.tsx`**

Create `hub/src/web/frontend/src/pages/add-agent/steps/Step1Target.tsx`:

```tsx
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
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`

Expected: clean.

- [ ] **Step 4: Run frontend build to confirm bundling works**

Run: `cd hub/src/web/frontend && npm run build && cd ../../../..`

Expected: build succeeds, no TS errors.

- [ ] **Step 5: Commit**

```bash
git add hub/src/web/frontend/src/pages/add-agent/AddAgentPage.tsx \
        hub/src/web/frontend/src/pages/add-agent/steps/Step1Target.tsx
git commit -m "feat(frontend): wizard shell + Step 1 (target picker)"
```

---

## Task 4: Step 2 (Connection) + Step 3 (Options)

**Files:**
- Create: `hub/src/web/frontend/src/pages/add-agent/steps/Step2Connection.tsx`
- Create: `hub/src/web/frontend/src/pages/add-agent/steps/Step3Options.tsx`
- Modify: `hub/src/web/frontend/src/pages/add-agent/AddAgentPage.tsx` (replace placeholders for steps 2 + 3)

- [ ] **Step 1: Create `Step2Connection.tsx`**

Create `hub/src/web/frontend/src/pages/add-agent/steps/Step2Connection.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { FormField, Input } from '@/components/FormField';
import type { WizardState, BrokerDefaults } from '../types';

const IDENTIFIER_LABEL: Record<NonNullable<WizardState['target']>, { label: string; placeholder: string; help: string }> = {
  docker:     { label: 'Host ID',      placeholder: 'nas-01',      help: 'Unique name for this host. Used in URLs and reports.' },
  'in-guest': { label: 'Host ID',      placeholder: 'n8n-vm',      help: 'Unique name for this guest. The PVE side identifies it via SMBIOS UUID or hostname/MAC.' },
  pve:        { label: 'Host ID',      placeholder: 'proxmox-01',  help: 'Should match the PVE node hostname (output of `hostname` on the PVE shell).' },
  k8s:        { label: 'Cluster name', placeholder: 'homelab-k3s', help: 'Applied to all DaemonSet pods. Used to group nodes in the UI.' },
};

interface HostsRow { host_id: string }

export function Step2Connection({ state, setState }: { state: WizardState; setState: (u: (s: WizardState) => WizardState) => void }) {
  const { data: defaults } = useQuery({
    queryKey: queryKeys.agentSetup(),
    queryFn: () => api<BrokerDefaults>('/agent-setup'),
    refetchInterval: false,
  });
  const { data: hosts } = useQuery({
    queryKey: queryKeys.hosts(),
    queryFn: () => api<HostsRow[]>('/hosts'),
    refetchInterval: false,
  });

  const target = state.target!;
  const ident = IDENTIFIER_LABEL[target];
  const collision = hosts?.some(h => h.host_id === state.identifier.trim()) ?? false;

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
      {collision && target !== 'k8s' && (
        <p className="rounded border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
          Host ID '{state.identifier}' already exists. Continuing will replace its agent.
        </p>
      )}

      <div className="space-y-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={state.useDefaultBroker}
            onChange={e => setState(s => ({ ...s, useDefaultBroker: e.target.checked }))}
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
```

- [ ] **Step 2: Create `Step3Options.tsx`**

Create `hub/src/web/frontend/src/pages/add-agent/steps/Step3Options.tsx`:

```tsx
import { FormField, Input, Select } from '@/components/FormField';
import type { WizardState } from '../types';

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
            </FormField>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Wire steps 2 + 3 into the shell**

In `AddAgentPage.tsx`, replace the existing imports + placeholder lines.

Replace:
```tsx
import { Step1Target } from './steps/Step1Target';
```
with:
```tsx
import { Step1Target } from './steps/Step1Target';
import { Step2Connection } from './steps/Step2Connection';
import { Step3Options } from './steps/Step3Options';
```

Replace the body of the `<div>` block currently rendering placeholders:
```tsx
{step === 1 && <Step1Target state={state} setState={setState} />}
{step === 2 && <PlaceholderStep label="Connection (Step 2 — Task 4)" />}
{step === 3 && <PlaceholderStep label="Options (Step 3 — Task 4)" />}
{step === 4 && <PlaceholderStep label="Install (Step 4 — Task 5)" />}
```
with:
```tsx
{step === 1 && <Step1Target state={state} setState={setState} />}
{step === 2 && <Step2Connection state={state} setState={setState} />}
{step === 3 && <Step3Options state={state} setState={setState} />}
{step === 4 && <PlaceholderStep label="Install (Step 4 — Task 5)" />}
```

- [ ] **Step 4: Typecheck + build**

```bash
npm run typecheck
cd hub/src/web/frontend && npm run build && cd ../../../..
```

Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add hub/src/web/frontend/src/pages/add-agent/steps/Step2Connection.tsx \
        hub/src/web/frontend/src/pages/add-agent/steps/Step3Options.tsx \
        hub/src/web/frontend/src/pages/add-agent/AddAgentPage.tsx
git commit -m "feat(frontend): wizard Step 2 (connection) + Step 3 (options)"
```

---

## Task 5: Step 4 (Install + verify) + route swap + delete old page

**Files:**
- Create: `hub/src/web/frontend/src/pages/add-agent/steps/Step4Install.tsx`
- Modify: `hub/src/web/frontend/src/pages/add-agent/AddAgentPage.tsx` (wire Step 4; final-step button label/behavior)
- Modify: `hub/src/web/frontend/src/lib/queryKeys.ts` (add `agentSetupCheck`)
- Modify: `hub/src/web/frontend/src/App.tsx` (lazy import path swap)
- Delete: `hub/src/web/frontend/src/pages/AddAgentPage.tsx`

- [ ] **Step 1: Add the query key**

In `hub/src/web/frontend/src/lib/queryKeys.ts`, find `agentSetup: () => ['agent-setup'] as const,` (line 61) and add the next line:

```ts
agentSetup: () => ['agent-setup'] as const,
agentSetupCheck: (target: string, identifier: string) => ['agent-setup-check', target, identifier] as const,
```

- [ ] **Step 2: Create `Step4Install.tsx`**

Create `hub/src/web/frontend/src/pages/add-agent/steps/Step4Install.tsx`:

```tsx
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
```

- [ ] **Step 3: Wire Step 4 + final-button behavior into the shell**

In `AddAgentPage.tsx`, add the import:

```tsx
import { Step4Install } from './steps/Step4Install';
```

Replace the step-4 placeholder line with:

```tsx
{step === 4 && <Step4Install state={state} />}
```

The wizard footer's Next button should become a "Done" button on step 4 that navigates home. Replace the current `<Button … Next →</Button>` block with:

```tsx
{step < 4 ? (
  <Button onClick={() => setStep(s => Math.min(4, s + 1) as 1|2|3|4)} disabled={!canAdvance}>
    Next →
  </Button>
) : (
  <Button onClick={() => window.location.hash = '#/hosts'}>
    Done
  </Button>
)}
```

(Use `window.location.hash` because the project uses `HashRouter` per `App.tsx:1`. No need for `useNavigate` here.)

- [ ] **Step 4: Swap the route to point at the new page**

In `hub/src/web/frontend/src/App.tsx` line 26:

```tsx
const AddAgentPage = lazy(() => import('@/pages/AddAgentPage').then(m => ({ default: m.AddAgentPage })));
```

Change to:

```tsx
const AddAgentPage = lazy(() => import('@/pages/add-agent/AddAgentPage').then(m => ({ default: m.AddAgentPage })));
```

- [ ] **Step 5: Delete the old page**

```bash
git rm hub/src/web/frontend/src/pages/AddAgentPage.tsx
```

- [ ] **Step 6: Typecheck + build**

```bash
npm run typecheck
cd hub/src/web/frontend && npm run build && cd ../../../..
```

Expected: both pass.

- [ ] **Step 7: Run the full test suite**

```bash
npm test
```

Expected: green.

- [ ] **Step 8: Commit**

```bash
git add hub/src/web/frontend/src/pages/add-agent/steps/Step4Install.tsx \
        hub/src/web/frontend/src/pages/add-agent/AddAgentPage.tsx \
        hub/src/web/frontend/src/lib/queryKeys.ts \
        hub/src/web/frontend/src/App.tsx
git commit -m "feat(frontend): wizard Step 4 (install + live verify) + route swap"
```

---

## Task 6: Manual UX verification on vdev

This task is for the human operator after the code lands and is deployed to vdev.

- [ ] **Step 1: Deploy hub to vdev**

Use the standard vdev deploy loop (memory: `reference_insightd_ops`).

- [ ] **Step 2: Walk all 4 wizard targets**

Open `https://<vdev-hub>/#/add-agent` and walk through each target end-to-end:

| Target | Identifier | Expected verification |
|---|---|---|
| Docker | `vdev-test-$(date +%s)` | Run emitted command on vdev itself; verification flips to "Connected" within 30s |
| Kubernetes | `insightd-test` | Apply emitted manifest against existing k3d test cluster (memory: `reference_k3d_test_env`); verification flips to "Connected" |
| Proxmox VE | `proxmox-01` | Collision warning fires (existing host); after a `pve-cluster` cycle, verification shows the actual cluster name |
| In-guest | `n8n-vm-test` | Run emitted command on n8n VM (10.0.0.125); first verification flips to "Connected"; within ~30s flips to "auto-linked to proxmox-01 / VMID …" |

- [ ] **Step 3: Verify Advanced disclosure works**

On any target, open Step 3 → click "Show advanced" → set a non-default value (e.g. collection interval = 10) → advance to Step 4 → confirm the env var appears in the command.

- [ ] **Step 4: Verify Skip-auto-link affordance**

Pick the in-guest target with an identifier that won't auto-link (e.g. fresh container ID with no PVE side). Wait 60 seconds at Step 4 → confirm "Skip auto-link check" link appears → click it → verification settles to generic "Connected".

- [ ] **Step 5: Verify Back/Stepper jump works**

On Step 3, click the "1. Target" pill → confirm it jumps back to Step 1, state preserved.

- [ ] **Step 6: Done**

If all 5 verification steps pass, the feature is ready to merge / tag.

---

## Self-Review Notes

- **Spec coverage:** All 6 spec sections (architecture, state shape, 4 step components, backend endpoint, edge cases, testing) have at least one task.
- **Edge cases mapped:** identifier collision (Step 2), broker-defaults fetch failure (handled inline by useQuery + placeholder fallback), waiting-state UI (Step 4), in-guest false-target case + 60s skip affordance (Step 4 + Task 6 step 4), k8s detection by `host_group + runtime_type='kubernetes'` (Task 1), standalone PVE pveCluster=null (Task 1).
- **No backfill, no schema change, no agent code change** — pure additive frontend + one read-only backend endpoint.
- **Old page deletion is in Task 5** to keep the wizard reachable through the route during Tasks 3–4 iterations.
- **Frontend has no component-level tests** by codebase convention — coverage comes from builder unit tests (deterministic command generation) + manual UX test (Task 6).
