# Proxmox Guest ↔ In-Guest Host Auto-Correlation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically link in-guest insightd agents to the PVE-reported guest entries representing the same VM/CT, and route the UI so users see one unified host page per guest instead of two unrelated entities.

**Architecture:** In-guest agent collects identity hints (virt type, qemu UUID, hostname, primary MAC) and publishes them on a new MQTT topic. Hub joins hints against PVE inventory in `container_snapshots`, persists the resulting link to four new columns on `hosts`. UI reads the link to redirect from PVE container detail → in-guest host detail and to render a "Hypervisor info" section on the host page.

**Tech Stack:** Node.js 20, TypeScript (strict), SQLite (better-sqlite3), MQTT (mosquitto), React 19, `node:test` + tsx. Schema migration v51.

**Spec:** `docs/superpowers/specs/2026-05-09-proxmox-guest-host-correlation-design.md`

---

## File structure

**New files:**
- `agent/src/collectors/identity-hint.ts` — virt detection + hint payload
- `hub/src/identity/matcher.ts` — hint-to-PVE-guest matching
- `hub/src/identity/labelExtractor.ts` — manual override label parser
- `tests/agent/identity-hint.test.ts`
- `tests/hub/identity-matcher.test.ts`
- `tests/hub/identity-mqtt-handler.test.ts`
- `tests/hub/identity-label-override.test.ts`
- `tests/integration/identity-link.test.ts`

**Modified files:**
- `hub/src/db/schema.ts` — v51 migration (5 new columns + 1 index)
- `agent/src/runtime/types.ts` — add `guestUuid`, `guestPrimaryMac` fields
- `agent/src/runtime/proxmox.ts` — collect uuid + mac from PVE config
- `agent/src/mqtt.ts` — propagate new fields in container snapshot publish; add `publishIdentityHint`
- `hub/src/mqtt.ts` — read new fields into DB; add identity-hint subscriber
- `agent/src/index.ts` — call identity hint publish on startup
- `agent/src/scheduler.ts` — re-publish hint on change
- `hub/src/web/api/hosts.ts` (or equivalent host detail handler) — add `proxmox` block
- `hub/src/web/api/containers.ts` (or equivalent container detail handler) — add `linkedHostId`
- `hub/src/web/frontend/src/pages/containers/ContainerDetailPage.tsx` — redirect logic
- `hub/src/web/frontend/src/pages/hosts/HostDetailPage.tsx` — Hypervisor info section
- `hub/src/web/frontend/src/pages/hosts/HostsPage.tsx` — linked badge
- Glossary file — new `hypervisor-link` entry

---

## Task 1: Schema migration v51

**Files:**
- Modify: `hub/src/db/schema.ts`
- Test: `tests/hub/schema-v51.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/hub/schema-v51.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initSchema } from '../../hub/src/db/schema';

test('v51 adds proxmox link columns to hosts and uuid/mac to container_snapshots', () => {
  const db = new Database(':memory:');
  initSchema(db);

  const hostsCols = db.prepare("PRAGMA table_info(hosts)").all() as Array<{ name: string }>;
  const names = new Set(hostsCols.map(c => c.name));
  assert.ok(names.has('proxmox_cluster_id'));
  assert.ok(names.has('proxmox_node'));
  assert.ok(names.has('proxmox_vmid'));
  assert.ok(names.has('proxmox_guest_type'));

  const csCols = db.prepare("PRAGMA table_info(container_snapshots)").all() as Array<{ name: string }>;
  const csNames = new Set(csCols.map(c => c.name));
  assert.ok(csNames.has('guest_uuid'));
  assert.ok(csNames.has('guest_primary_mac'));

  const indexes = db.prepare("PRAGMA index_list(hosts)").all() as Array<{ name: string }>;
  assert.ok(indexes.some(i => i.name === 'hosts_proxmox_link'));

  const version = db.prepare("SELECT value FROM settings WHERE key='schema_version'").get() as { value: string };
  assert.equal(parseInt(version.value, 10), 51);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/andreas/insightd
npx tsx --test tests/hub/schema-v51.test.ts
```

Expected: FAIL — columns and version are still v50.

- [ ] **Step 3: Add the migration in `hub/src/db/schema.ts`**

Locate the existing migration block that ends at v50. After the v50 block, add:

```typescript
// v51: proxmox guest <-> host correlation
if (currentVersion < 51) {
  try { db.exec('ALTER TABLE hosts ADD COLUMN proxmox_cluster_id TEXT'); } catch { /* exists */ }
  try { db.exec('ALTER TABLE hosts ADD COLUMN proxmox_node TEXT'); } catch { /* exists */ }
  try { db.exec('ALTER TABLE hosts ADD COLUMN proxmox_vmid INTEGER'); } catch { /* exists */ }
  try { db.exec('ALTER TABLE hosts ADD COLUMN proxmox_guest_type TEXT'); } catch { /* exists */ }
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS hosts_proxmox_link
             ON hosts (proxmox_cluster_id, proxmox_vmid)
             WHERE proxmox_vmid IS NOT NULL`);
  } catch { /* exists */ }
  try { db.exec('ALTER TABLE container_snapshots ADD COLUMN guest_uuid TEXT'); } catch { /* exists */ }
  try { db.exec('ALTER TABLE container_snapshots ADD COLUMN guest_primary_mac TEXT'); } catch { /* exists */ }
  db.prepare("UPDATE settings SET value = '51' WHERE key = 'schema_version'").run();
}
```

Also bump the bootstrap CREATE TABLE statements: add `proxmox_cluster_id TEXT, proxmox_node TEXT, proxmox_vmid INTEGER, proxmox_guest_type TEXT` to the `hosts` CREATE TABLE so fresh installs get them, and `guest_uuid TEXT, guest_primary_mac TEXT` to the `container_snapshots` CREATE TABLE. Update the `LATEST_SCHEMA_VERSION` constant from 50 → 51.

- [ ] **Step 4: Run test to verify it passes**

```bash
npx tsx --test tests/hub/schema-v51.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run full test suite to confirm no regressions**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add hub/src/db/schema.ts tests/hub/schema-v51.test.ts
git commit -m "feat(db): schema v51 — proxmox link columns on hosts + uuid/mac on container_snapshots"
```

---

## Task 2: Extend runtime types

**Files:**
- Modify: `agent/src/runtime/types.ts`

- [ ] **Step 1: Inspect current `ContainerInfo` shape**

```bash
grep -n "guestVmid\|guestType\|interface ContainerInfo" agent/src/runtime/types.ts
```

- [ ] **Step 2: Add the two new optional fields next to the existing guest fields**

In `agent/src/runtime/types.ts`, locate the `ContainerInfo` interface (or the type that holds `guestVmid?: number | null`). Add:

```typescript
  guestUuid?: string | null;        // qemu only — SMBIOS system UUID
  guestPrimaryMac?: string | null;  // qemu or lxc — first NIC MAC from PVE config
```

Keep them `?` and nullable so all existing call sites remain valid.

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS (no consumers yet).

- [ ] **Step 4: Commit**

```bash
git add agent/src/runtime/types.ts
git commit -m "feat(agent): add guestUuid + guestPrimaryMac to ContainerInfo"
```

---

## Task 3: Collect qemu UUID + LXC mac in PVE collector

**Files:**
- Modify: `agent/src/runtime/proxmox.ts`
- Test: `tests/agent/proxmox-uuid-mac.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/agent/proxmox-uuid-mac.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQemuSmbios, parseLxcNet0Hwaddr } from '../../agent/src/runtime/proxmox';

test('parseQemuSmbios extracts uuid', () => {
  const raw = 'uuid=12345678-1234-1234-1234-1234567890ab,manufacturer=ABC';
  assert.equal(parseQemuSmbios(raw), '12345678-1234-1234-1234-1234567890ab');
});

test('parseQemuSmbios returns null when no uuid', () => {
  assert.equal(parseQemuSmbios('manufacturer=ABC'), null);
  assert.equal(parseQemuSmbios(''), null);
  assert.equal(parseQemuSmbios(undefined), null);
});

test('parseLxcNet0Hwaddr extracts hwaddr (case-insensitive)', () => {
  const raw = 'name=eth0,bridge=vmbr0,hwaddr=BC:24:11:00:00:01,ip=dhcp';
  assert.equal(parseLxcNet0Hwaddr(raw), 'bc:24:11:00:00:01');
});

test('parseLxcNet0Hwaddr returns null when missing', () => {
  assert.equal(parseLxcNet0Hwaddr('name=eth0,bridge=vmbr0'), null);
  assert.equal(parseLxcNet0Hwaddr(''), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx tsx --test tests/agent/proxmox-uuid-mac.test.ts
```

Expected: FAIL — `parseQemuSmbios` / `parseLxcNet0Hwaddr` not exported.

- [ ] **Step 3: Implement and export the two parsers in `agent/src/runtime/proxmox.ts`**

Near the top of the file (after imports), add:

```typescript
export function parseQemuSmbios(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const m = raw.match(/(?:^|,)uuid=([0-9a-fA-F-]{36})/);
  return m ? m[1].toLowerCase() : null;
}

export function parseLxcNet0Hwaddr(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const m = raw.match(/(?:^|,)hwaddr=([0-9a-fA-F:]{17})/i);
  return m ? m[1].toLowerCase() : null;
}
```

- [ ] **Step 4: Wire the parsers into the existing guest collection**

In the function that builds `ContainerInfo` for each PVE guest (around `agent/src/runtime/proxmox.ts:163`), add a config fetch + parse for each guest. For REST mode, use the existing `pveApi` client to call `/nodes/<node>/qemu/<vmid>/config` (qemu) or `/nodes/<node>/lxc/<vmid>/config` (lxc). For pvesh mode, use the existing pvesh wrapper.

After the existing `displayName` line, before `guests.push({...`:

```typescript
let guestUuid: string | null = null;
let guestPrimaryMac: string | null = null;
try {
  if (r.type === 'qemu') {
    const cfg = await api.getQemuConfig(r.node, r.vmid);
    guestUuid = parseQemuSmbios(cfg?.smbios1 ?? null);
  } else if (r.type === 'lxc') {
    const cfg = await api.getLxcConfig(r.node, r.vmid);
    guestPrimaryMac = parseLxcNet0Hwaddr(cfg?.net0 ?? null);
  }
} catch (err) {
  logger.debug('proxmox', `Failed to fetch ${r.type} config for ${r.node}/${r.vmid}: ${(err as Error).message}`);
}
```

Then add to the `guests.push({...})` block:

```typescript
        guestUuid,
        guestPrimaryMac,
```

If `getQemuConfig` / `getLxcConfig` don't yet exist on the API client, add thin wrappers in `agent/src/runtime/pveApi.ts` (and the corresponding pvesh wrapper) that GET the config endpoint and return the JSON object. Keep them small — just the fetch + JSON parse.

- [ ] **Step 5: Run the parser tests + typecheck**

```bash
npx tsx --test tests/agent/proxmox-uuid-mac.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add agent/src/runtime/proxmox.ts agent/src/runtime/pveApi.ts agent/src/runtime/pvesh.ts tests/agent/proxmox-uuid-mac.test.ts
git commit -m "feat(agent): collect qemu UUID + LXC primary MAC from PVE config"
```

---

## Task 4: Propagate new fields through MQTT publish

**Files:**
- Modify: `agent/src/mqtt.ts`
- Modify: `hub/src/mqtt.ts`

- [ ] **Step 1: Inspect the existing container payload shape on agent side**

```bash
grep -n "guest_vmid\|guest_type" agent/src/mqtt.ts
```

- [ ] **Step 2: Add the two new fields to the agent-side container payload**

In `agent/src/mqtt.ts`, near the existing `guest_vmid: c.guestVmid ?? null` line (around line 342), add:

```typescript
    guest_uuid: c.guestUuid ?? null,
    guest_primary_mac: c.guestPrimaryMac ?? null,
```

Update the TypeScript interface at the top of the same file (the one that defines the container payload shape) to include `guest_uuid?: string | null` and `guest_primary_mac?: string | null`.

- [ ] **Step 3: Add the two fields to the hub-side payload type + persistence**

In `hub/src/mqtt.ts`, near the existing `guest_vmid?: number | null` (line ~79), add:

```typescript
    guest_uuid?: string | null;
    guest_primary_mac?: string | null;
```

In the function that upserts `container_snapshots` rows, add the two columns to the INSERT statement and to the parameter map. Find the existing INSERT for container_snapshots (search for `INSERT INTO container_snapshots`) and add `guest_uuid` and `guest_primary_mac` to both the column list and the VALUES placeholders.

- [ ] **Step 4: Run typecheck + tests**

```bash
npm run typecheck
npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/src/mqtt.ts hub/src/mqtt.ts
git commit -m "feat(mqtt): propagate guest_uuid + guest_primary_mac through container snapshots"
```

---

## Task 5: Identity hint collector (agent)

**Files:**
- Create: `agent/src/collectors/identity-hint.ts`
- Test: `tests/agent/identity-hint.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/agent/identity-hint.test.ts
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';

import { collectIdentityHint } from '../../agent/src/collectors/identity-hint';

function mockReadFile(map: Record<string, string | Error>) {
  return mock.method(fs, 'readFileSync', (p: any) => {
    const key = String(p);
    const v = map[key];
    if (v === undefined) { const e: any = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
    if (v instanceof Error) throw v;
    return v;
  });
}

test('detects qemu via DMI sys_vendor and reads UUID', () => {
  const restoreFs = mockReadFile({
    '/sys/class/dmi/id/sys_vendor': 'QEMU\n',
    '/sys/class/dmi/id/product_uuid': '12345678-1234-1234-1234-1234567890ab\n',
  });
  mock.method(os, 'hostname', () => 'qemu-vm');
  mock.method(os, 'networkInterfaces', () => ({
    eth0: [{ mac: 'bc:24:11:00:00:01', internal: false, family: 'IPv4', address: '10.0.0.10' }],
  }));

  const hint = collectIdentityHint();
  assert.equal(hint.virt_type, 'qemu');
  assert.equal(hint.system_uuid, '12345678-1234-1234-1234-1234567890ab');
  assert.equal(hint.hostname, 'qemu-vm');
  assert.equal(hint.primary_mac, 'bc:24:11:00:00:01');

  restoreFs.mock.restore();
  mock.restoreAll();
});

test('detects lxc via /proc/1/environ', () => {
  mockReadFile({
    '/proc/1/environ': 'PATH=/usr/bin\0container=lxc\0HOME=/root\0',
  });
  mock.method(os, 'hostname', () => 'web01');
  mock.method(os, 'networkInterfaces', () => ({
    eth0: [{ mac: 'bc:24:11:00:00:02', internal: false, family: 'IPv4', address: '10.0.0.11' }],
  }));

  const hint = collectIdentityHint();
  assert.equal(hint.virt_type, 'lxc');
  assert.equal(hint.system_uuid, null);
  assert.equal(hint.hostname, 'web01');
  assert.equal(hint.primary_mac, 'bc:24:11:00:00:02');

  mock.restoreAll();
});

test('detects bare metal when no signals', () => {
  mockReadFile({});
  mock.method(os, 'hostname', () => 'bare');
  mock.method(os, 'networkInterfaces', () => ({}));

  const hint = collectIdentityHint();
  assert.equal(hint.virt_type, 'bare');
  assert.equal(hint.system_uuid, null);
  assert.equal(hint.primary_mac, null);

  mock.restoreAll();
});

test('skips loopback and zero-MAC interfaces', () => {
  mockReadFile({});
  mock.method(os, 'hostname', () => 'h');
  mock.method(os, 'networkInterfaces', () => ({
    lo: [{ mac: '00:00:00:00:00:00', internal: true, family: 'IPv4', address: '127.0.0.1' }],
    docker0: [{ mac: '00:00:00:00:00:00', internal: false, family: 'IPv4', address: '172.17.0.1' }],
    eth0: [{ mac: 'bc:24:11:00:00:03', internal: false, family: 'IPv4', address: '10.0.0.12' }],
  }));

  const hint = collectIdentityHint();
  assert.equal(hint.primary_mac, 'bc:24:11:00:00:03');

  mock.restoreAll();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx tsx --test tests/agent/identity-hint.test.ts
```

Expected: FAIL — `collectIdentityHint` not defined.

- [ ] **Step 3: Implement the collector**

Create `agent/src/collectors/identity-hint.ts`:

```typescript
import * as fs from 'node:fs';
import * as os from 'node:os';

export type IdentityHint = {
  virt_type: 'qemu' | 'lxc' | 'bare';
  system_uuid: string | null;
  hostname: string;
  primary_mac: string | null;
};

function safeRead(path: string): string | null {
  try { return fs.readFileSync(path, 'utf8'); } catch { return null; }
}

function detectVirtType(): IdentityHint['virt_type'] {
  const sysVendor = safeRead('/sys/class/dmi/id/sys_vendor');
  if (sysVendor && sysVendor.trim() === 'QEMU') return 'qemu';

  const env = safeRead('/proc/1/environ');
  if (env && env.includes('container=lxc')) return 'lxc';

  const cgroup = safeRead('/proc/self/cgroup');
  if (cgroup && /lxc\.payload\.\d+/.test(cgroup)) return 'lxc';

  return 'bare';
}

function readQemuUuid(): string | null {
  const raw = safeRead('/sys/class/dmi/id/product_uuid');
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  return /^[0-9a-f-]{36}$/.test(trimmed) ? trimmed : null;
}

function pickPrimaryMac(): string | null {
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    for (const a of addrs) {
      if (a.internal) continue;
      if (!a.mac || a.mac === '00:00:00:00:00:00') continue;
      // Skip docker bridges (typical naming)
      if (/^(docker|br-|veth|virbr|cni|flannel|cali)/.test(name)) continue;
      return a.mac.toLowerCase();
    }
  }
  return null;
}

export function collectIdentityHint(): IdentityHint {
  const virt_type = detectVirtType();
  return {
    virt_type,
    system_uuid: virt_type === 'qemu' ? readQemuUuid() : null,
    hostname: os.hostname(),
    primary_mac: pickPrimaryMac(),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx tsx --test tests/agent/identity-hint.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/src/collectors/identity-hint.ts tests/agent/identity-hint.test.ts
git commit -m "feat(agent): identity-hint collector — virt detection + uuid/hostname/mac"
```

---

## Task 6: Publish identity hint over MQTT

**Files:**
- Modify: `agent/src/mqtt.ts`
- Modify: `agent/src/index.ts`
- Modify: `agent/src/scheduler.ts`
- Test: `tests/agent/identity-hint-publish.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/agent/identity-hint-publish.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIdentityHintTopic, buildIdentityHintPayload } from '../../agent/src/mqtt';

test('builds correct identity-hint topic per host', () => {
  assert.equal(buildIdentityHintTopic('proxmox-01'), 'insightd/proxmox-01/identity-hint');
});

test('payload omits virt_type=bare', () => {
  const payload = buildIdentityHintPayload({
    virt_type: 'bare',
    system_uuid: null,
    hostname: 'h',
    primary_mac: null,
  });
  assert.equal(payload, null);
});

test('payload includes hint when virt_type is qemu', () => {
  const payload = buildIdentityHintPayload({
    virt_type: 'qemu',
    system_uuid: 'aaaa-bbbb',
    hostname: 'h',
    primary_mac: 'bc:24:11:00:00:01',
  });
  assert.deepEqual(JSON.parse(payload!), {
    virt_type: 'qemu',
    system_uuid: 'aaaa-bbbb',
    hostname: 'h',
    primary_mac: 'bc:24:11:00:00:01',
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx tsx --test tests/agent/identity-hint-publish.test.ts
```

Expected: FAIL — exports not defined.

- [ ] **Step 3: Add helpers + publish function in `agent/src/mqtt.ts`**

```typescript
import type { IdentityHint } from './collectors/identity-hint';

export function buildIdentityHintTopic(hostId: string): string {
  return `insightd/${hostId}/identity-hint`;
}

export function buildIdentityHintPayload(hint: IdentityHint): string | null {
  if (hint.virt_type === 'bare') return null;
  return JSON.stringify(hint);
}

// Add to the public publishers object:
export async function publishIdentityHint(hostId: string, hint: IdentityHint): Promise<void> {
  const payload = buildIdentityHintPayload(hint);
  if (payload === null) return;
  await client.publishAsync(buildIdentityHintTopic(hostId), payload, {
    qos: 1,
    retain: true,
  });
}
```

(Adapt `client.publishAsync` to whatever wrapper the existing publishers use — match the pattern of e.g. `publishCollection`.)

- [ ] **Step 4: Wire into agent startup in `agent/src/index.ts`**

After MQTT connect succeeds and before `scheduler.start()`, add:

```typescript
import { collectIdentityHint } from './collectors/identity-hint';

// Skip if manual override is set (preserves existing behavior)
if (!config.proxmoxNode || !config.proxmoxVmid) {
  const hint = collectIdentityHint();
  await safeCollect('identity-hint', () => publishIdentityHint(config.hostId, hint));
  // Cache for change-detect in scheduler
  scheduler.setLastIdentityHint(hint);
}
```

- [ ] **Step 5: Add change-detect path in `agent/src/scheduler.ts`**

Add to scheduler state:

```typescript
let lastIdentityHint: IdentityHint | null = null;

export function setLastIdentityHint(h: IdentityHint) { lastIdentityHint = h; }

function identityHintChanged(a: IdentityHint, b: IdentityHint): boolean {
  return a.virt_type !== b.virt_type
      || a.system_uuid !== b.system_uuid
      || a.hostname !== b.hostname
      || a.primary_mac !== b.primary_mac;
}
```

In the existing `runCollection` cycle (after the main collection but before MQTT publish), add (only when no manual override):

```typescript
if (!config.proxmoxNode || !config.proxmoxVmid) {
  const current = collectIdentityHint();
  if (lastIdentityHint && identityHintChanged(lastIdentityHint, current)) {
    await safeCollect('identity-hint', () => publishers.publishIdentityHint(config.hostId, current));
    lastIdentityHint = current;
  }
}
```

- [ ] **Step 6: Run tests + typecheck**

```bash
npm run typecheck
npx tsx --test tests/agent/identity-hint-publish.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add agent/src/mqtt.ts agent/src/index.ts agent/src/scheduler.ts tests/agent/identity-hint-publish.test.ts
git commit -m "feat(agent): publish identity hint on startup + on change"
```

---

## Task 7: Hub identity matcher

**Files:**
- Create: `hub/src/identity/matcher.ts`
- Test: `tests/hub/identity-matcher.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/hub/identity-matcher.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initSchema } from '../../hub/src/db/schema';
import { matchIdentityHint, IdentityHint } from '../../hub/src/identity/matcher';

function seedGuest(db: any, opts: {
  cluster_id: string; node: string; vmid: number; type: 'qemu' | 'lxc';
  name: string; uuid?: string; mac?: string;
}) {
  const ts = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO container_snapshots
    (host_id, container_id, container_name, cluster_id, guest_vmid, guest_type, guest_uuid, guest_primary_mac, collected_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running')`).run(
      opts.node, `${opts.node}/${opts.vmid}`, opts.name, opts.cluster_id, opts.vmid, opts.type,
      opts.uuid ?? null, opts.mac ?? null, ts);
}

test('qemu match by UUID', () => {
  const db = new Database(':memory:'); initSchema(db);
  seedGuest(db, { cluster_id: 'c1', node: 'pve1', vmid: 100, type: 'qemu', name: 'vm1', uuid: 'aaa-bbb' });
  const hint: IdentityHint = { virt_type: 'qemu', system_uuid: 'AAA-BBB', hostname: 'h', primary_mac: null };
  const result = matchIdentityHint(db, 'host-x', hint);
  assert.deepEqual(result, { cluster_id: 'c1', node: 'pve1', vmid: 100, guest_type: 'qemu' });
});

test('lxc match by hostname', () => {
  const db = new Database(':memory:'); initSchema(db);
  seedGuest(db, { cluster_id: 'c1', node: 'pve1', vmid: 200, type: 'lxc', name: 'web01' });
  const hint: IdentityHint = { virt_type: 'lxc', system_uuid: null, hostname: 'web01', primary_mac: null };
  const result = matchIdentityHint(db, 'host-x', hint);
  assert.deepEqual(result, { cluster_id: 'c1', node: 'pve1', vmid: 200, guest_type: 'lxc' });
});

test('lxc match by MAC when hostname differs', () => {
  const db = new Database(':memory:'); initSchema(db);
  seedGuest(db, { cluster_id: 'c1', node: 'pve1', vmid: 201, type: 'lxc', name: 'config-name', mac: 'bc:24:11:00:00:09' });
  const hint: IdentityHint = { virt_type: 'lxc', system_uuid: null, hostname: 'kernel-name', primary_mac: 'bc:24:11:00:00:09' };
  const result = matchIdentityHint(db, 'host-x', hint);
  assert.deepEqual(result, { cluster_id: 'c1', node: 'pve1', vmid: 201, guest_type: 'lxc' });
});

test('lxc both-match preferred when ambiguous on hostname', () => {
  const db = new Database(':memory:'); initSchema(db);
  seedGuest(db, { cluster_id: 'c1', node: 'pve1', vmid: 300, type: 'lxc', name: 'dup', mac: 'aa:aa:aa:aa:aa:01' });
  seedGuest(db, { cluster_id: 'c1', node: 'pve1', vmid: 301, type: 'lxc', name: 'dup', mac: 'aa:aa:aa:aa:aa:02' });
  const hint: IdentityHint = { virt_type: 'lxc', system_uuid: null, hostname: 'dup', primary_mac: 'aa:aa:aa:aa:aa:02' };
  const result = matchIdentityHint(db, 'host-x', hint);
  assert.equal(result?.vmid, 301);
});

test('lxc ambiguous returns null', () => {
  const db = new Database(':memory:'); initSchema(db);
  seedGuest(db, { cluster_id: 'c1', node: 'pve1', vmid: 400, type: 'lxc', name: 'dup' });
  seedGuest(db, { cluster_id: 'c1', node: 'pve1', vmid: 401, type: 'lxc', name: 'dup' });
  const hint: IdentityHint = { virt_type: 'lxc', system_uuid: null, hostname: 'dup', primary_mac: null };
  assert.equal(matchIdentityHint(db, 'host-x', hint), null);
});

test('no match returns null', () => {
  const db = new Database(':memory:'); initSchema(db);
  const hint: IdentityHint = { virt_type: 'qemu', system_uuid: 'unknown', hostname: 'h', primary_mac: null };
  assert.equal(matchIdentityHint(db, 'host-x', hint), null);
});

test('bare returns null', () => {
  const db = new Database(':memory:'); initSchema(db);
  const hint: IdentityHint = { virt_type: 'bare' as any, system_uuid: null, hostname: 'h', primary_mac: null };
  assert.equal(matchIdentityHint(db, 'host-x', hint), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx tsx --test tests/hub/identity-matcher.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the matcher**

Create `hub/src/identity/matcher.ts`:

```typescript
import type { Database } from 'better-sqlite3';

export type IdentityHint = {
  virt_type: 'qemu' | 'lxc' | 'bare';
  system_uuid: string | null;
  hostname: string;
  primary_mac: string | null;
};

export type IdentityMatch = {
  cluster_id: string;
  node: string;
  vmid: number;
  guest_type: 'qemu' | 'lxc';
};

type GuestRow = {
  cluster_id: string;
  node: string;
  vmid: number;
  guest_type: 'qemu' | 'lxc';
  guest_uuid: string | null;
  guest_primary_mac: string | null;
  container_name: string;
};

function latestGuestSnapshots(db: Database): GuestRow[] {
  return db.prepare(`
    SELECT cluster_id, host_id AS node, guest_vmid AS vmid,
           guest_type, guest_uuid, guest_primary_mac, container_name
      FROM container_snapshots cs
     WHERE guest_vmid IS NOT NULL
       AND collected_at = (
         SELECT MAX(collected_at) FROM container_snapshots cs2
          WHERE cs2.host_id = cs.host_id AND cs2.guest_vmid = cs.guest_vmid
       )
  `).all() as GuestRow[];
}

export function matchIdentityHint(
  db: Database,
  _hostId: string,
  hint: IdentityHint,
): IdentityMatch | null {
  if (hint.virt_type === 'bare') return null;
  const guests = latestGuestSnapshots(db);

  if (hint.virt_type === 'qemu') {
    if (!hint.system_uuid) return null;
    const wanted = hint.system_uuid.toLowerCase();
    const matches = guests.filter(g => g.guest_type === 'qemu' && (g.guest_uuid ?? '').toLowerCase() === wanted);
    if (matches.length !== 1) return null; // 0 or collision
    const g = matches[0];
    return { cluster_id: g.cluster_id, node: g.node, vmid: g.vmid, guest_type: 'qemu' };
  }

  // lxc
  const candidates = guests.filter(g => {
    if (g.guest_type !== 'lxc') return false;
    const nameMatch = g.container_name.toLowerCase().split('/').pop() === hint.hostname.toLowerCase();
    const macMatch = !!hint.primary_mac && g.guest_primary_mac?.toLowerCase() === hint.primary_mac.toLowerCase();
    return nameMatch || macMatch;
  });

  if (candidates.length === 0) return null;
  if (candidates.length === 1) {
    const g = candidates[0];
    return { cluster_id: g.cluster_id, node: g.node, vmid: g.vmid, guest_type: 'lxc' };
  }

  // Ambiguous: prefer the one where BOTH hostname AND mac match
  const both = candidates.filter(g =>
    g.container_name.toLowerCase().split('/').pop() === hint.hostname.toLowerCase()
    && !!hint.primary_mac
    && g.guest_primary_mac?.toLowerCase() === hint.primary_mac.toLowerCase()
  );
  if (both.length === 1) {
    const g = both[0];
    return { cluster_id: g.cluster_id, node: g.node, vmid: g.vmid, guest_type: 'lxc' };
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx tsx --test tests/hub/identity-matcher.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hub/src/identity/matcher.ts tests/hub/identity-matcher.test.ts
git commit -m "feat(hub): identity matcher — joins hint vs PVE inventory"
```

---

## Task 8: MQTT subscriber for identity hints + persistence

**Files:**
- Modify: `hub/src/mqtt.ts`
- Test: `tests/hub/identity-mqtt-handler.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/hub/identity-mqtt-handler.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initSchema } from '../../hub/src/db/schema';
import { handleIdentityHint } from '../../hub/src/mqtt';

function seedHost(db: any, hostId: string) {
  const ts = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO hosts (host_id, hostname, last_seen_at) VALUES (?, ?, ?)`).run(hostId, hostId, ts);
}
function seedGuest(db: any, opts: any) {
  const ts = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO container_snapshots
    (host_id, container_id, container_name, cluster_id, guest_vmid, guest_type, guest_uuid, guest_primary_mac, collected_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running')`).run(
      opts.node, `${opts.node}/${opts.vmid}`, opts.name, opts.cluster_id, opts.vmid, opts.type,
      opts.uuid ?? null, opts.mac ?? null, ts);
}

test('writes proxmox link on match', () => {
  const db = new Database(':memory:'); initSchema(db);
  seedHost(db, 'web01');
  seedGuest(db, { cluster_id: 'c1', node: 'pve1', vmid: 200, type: 'lxc', name: 'web01' });

  handleIdentityHint(db, 'web01', {
    virt_type: 'lxc', system_uuid: null, hostname: 'web01', primary_mac: null,
  });

  const row = db.prepare(`SELECT proxmox_cluster_id, proxmox_node, proxmox_vmid, proxmox_guest_type FROM hosts WHERE host_id='web01'`).get() as any;
  assert.deepEqual(row, { proxmox_cluster_id: 'c1', proxmox_node: 'pve1', proxmox_vmid: 200, proxmox_guest_type: 'lxc' });
});

test('NULLs link when previously linked but no longer matches', () => {
  const db = new Database(':memory:'); initSchema(db);
  seedHost(db, 'web01');
  db.prepare(`UPDATE hosts SET proxmox_cluster_id='old', proxmox_node='oldnode', proxmox_vmid=999, proxmox_guest_type='lxc' WHERE host_id='web01'`).run();
  // No PVE inventory matches
  handleIdentityHint(db, 'web01', {
    virt_type: 'lxc', system_uuid: null, hostname: 'web01', primary_mac: null,
  });
  const row = db.prepare(`SELECT proxmox_cluster_id, proxmox_vmid FROM hosts WHERE host_id='web01'`).get() as any;
  assert.equal(row.proxmox_cluster_id, null);
  assert.equal(row.proxmox_vmid, null);
});

test('bare hint is no-op (does not clear existing link)', () => {
  const db = new Database(':memory:'); initSchema(db);
  seedHost(db, 'h');
  db.prepare(`UPDATE hosts SET proxmox_cluster_id='c1', proxmox_vmid=100 WHERE host_id='h'`).run();
  handleIdentityHint(db, 'h', { virt_type: 'bare' as any, system_uuid: null, hostname: 'h', primary_mac: null });
  const row = db.prepare(`SELECT proxmox_cluster_id, proxmox_vmid FROM hosts WHERE host_id='h'`).get() as any;
  assert.equal(row.proxmox_cluster_id, 'c1');
  assert.equal(row.proxmox_vmid, 100);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx tsx --test tests/hub/identity-mqtt-handler.test.ts
```

Expected: FAIL — `handleIdentityHint` not exported.

- [ ] **Step 3: Implement handler in `hub/src/mqtt.ts`**

```typescript
import { matchIdentityHint, type IdentityHint } from './identity/matcher';

export function handleIdentityHint(db: Database, hostId: string, hint: IdentityHint): void {
  // Bare = no-op. Don't clear. Agent on bare metal might be temporarily
  // misdetecting; preserving last-known link is safer than churn.
  if (hint.virt_type === 'bare') return;

  const result = matchIdentityHint(db, hostId, hint);

  if (result) {
    db.prepare(`UPDATE hosts
                   SET proxmox_cluster_id = ?,
                       proxmox_node       = ?,
                       proxmox_vmid       = ?,
                       proxmox_guest_type = ?
                 WHERE host_id = ?`).run(result.cluster_id, result.node, result.vmid, result.guest_type, hostId);
    logger.info('identity', `Linked host=${hostId} -> ${result.node}/${result.vmid} (${result.guest_type})`);
  } else {
    const existing = db.prepare(`SELECT proxmox_vmid FROM hosts WHERE host_id = ?`).get(hostId) as { proxmox_vmid: number | null } | undefined;
    if (existing?.proxmox_vmid != null) {
      db.prepare(`UPDATE hosts
                     SET proxmox_cluster_id = NULL,
                         proxmox_node       = NULL,
                         proxmox_vmid       = NULL,
                         proxmox_guest_type = NULL
                   WHERE host_id = ?`).run(hostId);
      logger.info('identity', `Cleared link for host=${hostId} (no PVE match)`);
    }
  }
}
```

Subscribe to the topic in the MQTT init code (search for the existing `client.subscribe(...)` block):

```typescript
client.subscribe('insightd/+/identity-hint');

// In the message router:
if (topic.match(/^insightd\/[^/]+\/identity-hint$/)) {
  const hostId = topic.split('/')[1];
  try {
    const hint = JSON.parse(payload.toString()) as IdentityHint;
    handleIdentityHint(db, hostId, hint);
  } catch (err) {
    logger.warn('identity', `Bad identity-hint payload from host=${hostId}: ${(err as Error).message}`);
  }
  return;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx tsx --test tests/hub/identity-mqtt-handler.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hub/src/mqtt.ts tests/hub/identity-mqtt-handler.test.ts
git commit -m "feat(hub): MQTT subscriber for identity hints + persistence"
```

---

## Task 9: Manual override label compat

**Files:**
- Create: `hub/src/identity/labelExtractor.ts`
- Modify: `hub/src/mqtt.ts` (host_snapshot handler)
- Test: `tests/hub/identity-label-override.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/hub/identity-label-override.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractProxmoxLink } from '../../hub/src/identity/labelExtractor';

test('parses node/vmid from label', () => {
  assert.deepEqual(extractProxmoxLink({ 'insightd.proxmox.guest': 'pve1/108' }),
    { node: 'pve1', vmid: 108 });
});

test('returns null when label missing', () => {
  assert.equal(extractProxmoxLink({}), null);
  assert.equal(extractProxmoxLink(null as any), null);
  assert.equal(extractProxmoxLink(undefined as any), null);
});

test('returns null when value malformed', () => {
  assert.equal(extractProxmoxLink({ 'insightd.proxmox.guest': 'no-slash' }), null);
  assert.equal(extractProxmoxLink({ 'insightd.proxmox.guest': 'pve/notnum' }), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx tsx --test tests/hub/identity-label-override.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement extractor**

Create `hub/src/identity/labelExtractor.ts`:

```typescript
export function extractProxmoxLink(labels: Record<string, string> | null | undefined): { node: string; vmid: number } | null {
  if (!labels) return null;
  const v = labels['insightd.proxmox.guest'];
  if (!v) return null;
  const idx = v.indexOf('/');
  if (idx <= 0) return null;
  const node = v.slice(0, idx);
  const vmidStr = v.slice(idx + 1);
  const vmid = parseInt(vmidStr, 10);
  if (!node || !Number.isFinite(vmid) || String(vmid) !== vmidStr) return null;
  return { node, vmid };
}
```

- [ ] **Step 4: Wire into the host_snapshot handler in `hub/src/mqtt.ts`**

In the function that processes incoming host_snapshot payloads (search for `host_snapshots` INSERT or `host_labels` write), after the labels are parsed but before the existing INSERT, add:

```typescript
import { extractProxmoxLink } from './identity/labelExtractor';

const labels: Record<string, string> = parsedPayload.labels ?? {};
const manualLink = extractProxmoxLink(labels);
if (manualLink) {
  // Resolve cluster_id from PVE inventory keyed on node + vmid
  const row = db.prepare(`SELECT cluster_id, guest_type FROM container_snapshots
                            WHERE host_id = ? AND guest_vmid = ?
                         ORDER BY collected_at DESC LIMIT 1`).get(manualLink.node, manualLink.vmid) as { cluster_id: string; guest_type: string } | undefined;
  db.prepare(`UPDATE hosts
                 SET proxmox_cluster_id = ?, proxmox_node = ?, proxmox_vmid = ?, proxmox_guest_type = ?
               WHERE host_id = ?`).run(row?.cluster_id ?? null, manualLink.node, manualLink.vmid, row?.guest_type ?? null, hostId);
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx tsx --test tests/hub/identity-label-override.test.ts
npm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add hub/src/identity/labelExtractor.ts hub/src/mqtt.ts tests/hub/identity-label-override.test.ts
git commit -m "feat(hub): manual override label populates proxmox_* columns"
```

---

## Task 10: Re-run matcher on PVE inventory updates

**Files:**
- Modify: `hub/src/mqtt.ts`
- Test: `tests/hub/identity-deferred-match.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/hub/identity-deferred-match.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initSchema } from '../../hub/src/db/schema';
import { handleIdentityHint, rematchAllPendingHints, rememberIdentityHint } from '../../hub/src/mqtt';

test('hint received before PVE inventory; later inventory triggers match', () => {
  const db = new Database(':memory:'); initSchema(db);
  db.prepare(`INSERT INTO hosts (host_id, hostname) VALUES ('vm1', 'vm1')`).run();

  // Hint arrives first; no PVE data yet
  rememberIdentityHint('vm1', { virt_type: 'qemu', system_uuid: 'uuid-1', hostname: 'vm1', primary_mac: null });
  handleIdentityHint(db, 'vm1', { virt_type: 'qemu', system_uuid: 'uuid-1', hostname: 'vm1', primary_mac: null });
  let row = db.prepare(`SELECT proxmox_vmid FROM hosts WHERE host_id='vm1'`).get() as any;
  assert.equal(row.proxmox_vmid, null);

  // PVE inventory arrives
  const ts = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO container_snapshots
    (host_id, container_id, container_name, cluster_id, guest_vmid, guest_type, guest_uuid, collected_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running')`).run('pve1', 'pve1/100', 'vm1', 'c1', 100, 'qemu', 'uuid-1', ts);

  rematchAllPendingHints(db);

  row = db.prepare(`SELECT proxmox_vmid FROM hosts WHERE host_id='vm1'`).get() as any;
  assert.equal(row.proxmox_vmid, 100);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx tsx --test tests/hub/identity-deferred-match.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Add in-memory hint cache + rematch function in `hub/src/mqtt.ts`**

```typescript
const pendingHints = new Map<string, IdentityHint>();

export function rememberIdentityHint(hostId: string, hint: IdentityHint): void {
  if (hint.virt_type === 'bare') { pendingHints.delete(hostId); return; }
  pendingHints.set(hostId, hint);
}

export function rematchAllPendingHints(db: Database): void {
  for (const [hostId, hint] of pendingHints.entries()) {
    handleIdentityHint(db, hostId, hint);
  }
}
```

In the existing identity-hint topic handler (Task 8), call `rememberIdentityHint(hostId, hint)` before calling `handleIdentityHint`.

In the function that handles the PVE container snapshots topic (the one that upserts `container_snapshots`), at the end of processing a batch, call:

```typescript
if (incomingHasGuestVmid) {
  rematchAllPendingHints(db);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx tsx --test tests/hub/identity-deferred-match.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hub/src/mqtt.ts tests/hub/identity-deferred-match.test.ts
git commit -m "feat(hub): rematch pending identity hints when PVE inventory updates"
```

---

## Task 11: API extensions

**Files:**
- Modify: hub host detail handler (find via `grep -rn "/api/hosts/:id\|getHostDetail\|handleHostDetail" hub/src/web/`)
- Modify: hub container detail handler (find via `grep -rn "/api/containers/:id\|handleContainerDetail" hub/src/web/`)
- Test: `tests/hub/api-host-proxmox.test.ts`, `tests/hub/api-container-linked-host.test.ts`

- [ ] **Step 1: Locate handlers**

```bash
grep -rn "handleHostDetail\|/api/hosts/:" hub/src/web/ | head -5
grep -rn "handleContainerDetail\|/api/containers/:" hub/src/web/ | head -5
```

Note the file paths for the next steps.

- [ ] **Step 2: Write failing test for host detail**

```typescript
// tests/hub/api-host-proxmox.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initSchema } from '../../hub/src/db/schema';
import { buildHostDetailResponse } from '<the host detail module path>'; // fill in after grep

test('host detail includes proxmox block when linked', () => {
  const db = new Database(':memory:'); initSchema(db);
  const ts = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO hosts (host_id, hostname, proxmox_cluster_id, proxmox_node, proxmox_vmid, proxmox_guest_type) VALUES (?, ?, ?, ?, ?, ?)`).run('vm1', 'vm1', 'c1', 'pve1', 108, 'qemu');

  const resp = buildHostDetailResponse(db, 'vm1');
  assert.deepEqual(resp.proxmox, {
    cluster_id: 'c1', node: 'pve1', vmid: 108, guest_type: 'qemu',
    snapshots_count: 0, last_backup_at: null,
  });
});

test('host detail proxmox is null when not linked', () => {
  const db = new Database(':memory:'); initSchema(db);
  db.prepare(`INSERT INTO hosts (host_id, hostname) VALUES (?, ?)`).run('bare', 'bare');
  const resp = buildHostDetailResponse(db, 'bare');
  assert.equal(resp.proxmox, null);
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npx tsx --test tests/hub/api-host-proxmox.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Implement in the host detail handler**

Inside the function that builds the response, after the existing host row fetch, add:

```typescript
let proxmox = null;
if (host.proxmox_vmid != null) {
  const snapshotsCount = (db.prepare(
    `SELECT COUNT(*) AS n FROM pve_guest_snapshots WHERE host_id = ? AND guest_vmid = ?`
  ).get(host.proxmox_node, host.proxmox_vmid) as { n: number }).n;

  const lastBackup = db.prepare(
    `SELECT MAX(backup_time) AS t FROM pve_backups WHERE host_id = ? AND guest_vmid = ?`
  ).get(host.proxmox_node, host.proxmox_vmid) as { t: string | null };

  proxmox = {
    cluster_id: host.proxmox_cluster_id,
    node: host.proxmox_node,
    vmid: host.proxmox_vmid,
    guest_type: host.proxmox_guest_type,
    snapshots_count: snapshotsCount,
    last_backup_at: lastBackup?.t ?? null,
  };
}
return { ...existingResponse, proxmox };
```

(Adjust column names for `pve_guest_snapshots` / `pve_backups` to whatever the schema currently uses — confirm by grepping `hub/src/db/schema.ts:174-198`.)

- [ ] **Step 5: Write failing test for container detail `linkedHostId`**

```typescript
// tests/hub/api-container-linked-host.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initSchema } from '../../hub/src/db/schema';
import { buildContainerDetailResponse } from '<container detail module path>';

test('linkedHostId set when guest is linked to a host', () => {
  const db = new Database(':memory:'); initSchema(db);
  const ts = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO hosts (host_id, hostname, proxmox_cluster_id, proxmox_node, proxmox_vmid, proxmox_guest_type) VALUES (?, ?, ?, ?, ?, ?)`).run('vm1', 'vm1', 'c1', 'pve1', 108, 'qemu');
  db.prepare(`INSERT INTO container_snapshots (host_id, container_id, container_name, cluster_id, guest_vmid, guest_type, collected_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'running')`).run('pve1', 'pve1/108', 'vm1', 'c1', 108, 'qemu', ts);

  const resp = buildContainerDetailResponse(db, 'pve1/108');
  assert.equal(resp.linkedHostId, 'vm1');
});

test('linkedHostId null for unlinked guest', () => {
  const db = new Database(':memory:'); initSchema(db);
  const ts = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO container_snapshots (host_id, container_id, container_name, cluster_id, guest_vmid, guest_type, collected_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'running')`).run('pve1', 'pve1/200', 'orphan', 'c1', 200, 'lxc', ts);
  const resp = buildContainerDetailResponse(db, 'pve1/200');
  assert.equal(resp.linkedHostId, null);
});
```

- [ ] **Step 6: Run test to verify it fails**

```bash
npx tsx --test tests/hub/api-container-linked-host.test.ts
```

Expected: FAIL.

- [ ] **Step 7: Implement in container detail handler**

After the container row fetch, add:

```typescript
let linkedHostId: string | null = null;
if (container.guest_vmid != null) {
  const linked = db.prepare(
    `SELECT host_id FROM hosts WHERE proxmox_cluster_id = ? AND proxmox_vmid = ? LIMIT 1`
  ).get(container.cluster_id, container.guest_vmid) as { host_id: string } | undefined;
  linkedHostId = linked?.host_id ?? null;
}
return { ...existingResponse, linkedHostId };
```

- [ ] **Step 8: Run all new tests + full suite**

```bash
npx tsx --test tests/hub/api-host-proxmox.test.ts tests/hub/api-container-linked-host.test.ts
npm test
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add <api files> tests/hub/api-host-proxmox.test.ts tests/hub/api-container-linked-host.test.ts
git commit -m "feat(api): expose proxmox link on host detail + linkedHostId on container detail"
```

---

## Task 12: ContainerDetailPage redirect

**Files:**
- Modify: `hub/src/web/frontend/src/pages/containers/ContainerDetailPage.tsx`

- [ ] **Step 1: Locate the data fetch + render path**

```bash
grep -n "linkedHostId\|guest_vmid\|useQuery" hub/src/web/frontend/src/pages/containers/ContainerDetailPage.tsx | head
```

- [ ] **Step 2: Add redirect logic**

Near the top of the component, after the data-fetching hook resolves and before the main render:

```typescript
import { useNavigate, useSearchParams } from 'react-router-dom';

const navigate = useNavigate();
const [searchParams] = useSearchParams();
const bypass = searchParams.get('bypass_redirect') === '1';

useEffect(() => {
  if (!data) return;
  if (bypass) return;
  if (data.linkedHostId && data.status === 'running') {
    navigate(`/hosts/${data.linkedHostId}`, { replace: true });
  }
}, [data, bypass, navigate]);
```

Add an `if (data?.linkedHostId && data.status === 'running' && !bypass) return null;` early-return so the original PVE container UI doesn't flash before the redirect.

- [ ] **Step 3: Build frontend + verify typecheck**

```bash
cd hub/src/web/frontend && npm run build && cd ../../../..
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add hub/src/web/frontend/src/pages/containers/ContainerDetailPage.tsx hub/src/web/public/
git commit -m "feat(ui): redirect from PVE container detail to linked host detail"
```

---

## Task 13: HostDetailPage Hypervisor info section + HostsPage badge

**Files:**
- Modify: `hub/src/web/frontend/src/pages/hosts/HostDetailPage.tsx`
- Modify: `hub/src/web/frontend/src/pages/hosts/HostsPage.tsx`
- Create: `hub/src/web/frontend/src/components/HypervisorInfoCard.tsx`

- [ ] **Step 1: Create the HypervisorInfoCard component**

```tsx
// hub/src/web/frontend/src/components/HypervisorInfoCard.tsx
import { Link } from 'react-router-dom';
import { Card } from './Card';
import { GlossaryHelp } from './GlossaryHelp';

type Props = {
  proxmox: {
    cluster_id: string;
    node: string;
    vmid: number;
    guest_type: 'qemu' | 'lxc';
    snapshots_count: number;
    last_backup_at: string | null;
  };
};

export function HypervisorInfoCard({ proxmox }: Props) {
  const containerId = `${proxmox.node}/${proxmox.vmid}`;
  return (
    <Card className="border-l-4 border-purple-500">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-semibold">
          Hypervisor info <GlossaryHelp topic="hypervisor-link" />
        </h2>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
        <dt className="text-gray-500">PVE node</dt><dd>{proxmox.node}</dd>
        <dt className="text-gray-500">Type</dt><dd>{proxmox.guest_type}</dd>
        <dt className="text-gray-500">VMID</dt><dd>{proxmox.vmid}</dd>
        <dt className="text-gray-500">Cluster</dt><dd>{proxmox.cluster_id}</dd>
        <dt className="text-gray-500">Snapshots</dt><dd>{proxmox.snapshots_count}</dd>
        <dt className="text-gray-500">Last backup</dt><dd>{proxmox.last_backup_at ?? '—'}</dd>
      </dl>
      <Link to={`/containers/${encodeURIComponent(containerId)}?bypass_redirect=1`}
            className="text-blue-600 hover:underline text-sm mt-2 inline-block">
        → View on hypervisor
      </Link>
    </Card>
  );
}
```

- [ ] **Step 2: Wire into HostDetailPage**

Near the top of the rendered page, before the existing tabs:

```tsx
import { HypervisorInfoCard } from '../../components/HypervisorInfoCard';

{host.proxmox && <HypervisorInfoCard proxmox={host.proxmox} />}
```

- [ ] **Step 3: Add badge in HostsPage**

In the host row render, beside the hostname:

```tsx
{host.proxmox && (
  <span className="ml-2 text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded">
    🖥️ {host.proxmox.node}:{host.proxmox.vmid}
  </span>
)}
```

(Update the Hosts API response to include the `proxmox` field on each list row — same shape as host detail. Confirm by grepping the list endpoint handler.)

- [ ] **Step 4: Build + typecheck**

```bash
cd hub/src/web/frontend && npm run build && cd ../../../..
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hub/src/web/frontend/src/components/HypervisorInfoCard.tsx hub/src/web/frontend/src/pages/hosts/HostDetailPage.tsx hub/src/web/frontend/src/pages/hosts/HostsPage.tsx hub/src/web/public/
git commit -m "feat(ui): hypervisor info card on host detail + linked badge on hosts list"
```

---

## Task 14: Glossary entry

**Files:**
- Modify: glossary file (find via `grep -rn "GlossaryHelp\|glossary.json\|glossary.ts" hub/src/web/frontend/src/`)

- [ ] **Step 1: Locate glossary store**

```bash
grep -rn "topic=\"" hub/src/web/frontend/src/ | head -5
grep -rn "glossary" hub/src/web/frontend/src/ | head -5
```

- [ ] **Step 2: Add entry**

Add a new `hypervisor-link` entry following the existing format:

```typescript
'hypervisor-link': {
  title: 'Hypervisor link',
  body: 'When an in-guest insightd agent is detected as running inside a Proxmox VE guest (qemu VM or LXC container), insightd automatically links the two views: clicking the PVE-reported guest now navigates directly to the host page reported by the in-guest agent. The link is established by matching the guest\'s SMBIOS UUID (qemu) or hostname/MAC (LXC) against the PVE inventory.',
},
```

- [ ] **Step 3: Build + commit**

```bash
cd hub/src/web/frontend && npm run build && cd ../../../..
git add hub/src/web/frontend/src/<glossary file> hub/src/web/public/
git commit -m "docs(glossary): add hypervisor-link entry"
```

---

## Task 15: End-to-end integration test

**Files:**
- Create: `tests/integration/identity-link.test.ts`

- [ ] **Step 1: Write the integration test**

```typescript
// tests/integration/identity-link.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initSchema } from '../../hub/src/db/schema';
import { handleIdentityHint, rememberIdentityHint, rematchAllPendingHints } from '../../hub/src/mqtt';

function seedHost(db: any, id: string) {
  db.prepare(`INSERT INTO hosts (host_id, hostname) VALUES (?, ?)`).run(id, id);
}
function seedGuest(db: any, opts: any) {
  const ts = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO container_snapshots
    (host_id, container_id, container_name, cluster_id, guest_vmid, guest_type, guest_uuid, guest_primary_mac, collected_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running')`).run(
      opts.node, `${opts.node}/${opts.vmid}`, opts.name, opts.cluster_id, opts.vmid, opts.type,
      opts.uuid ?? null, opts.mac ?? null, ts);
}

test('full lifecycle: qemu link, lxc link, bare no-link, deferred match', () => {
  const db = new Database(':memory:'); initSchema(db);

  // Seed two PVE guests + three in-guest hosts
  seedGuest(db, { cluster_id: 'c1', node: 'pve1', vmid: 100, type: 'qemu', name: 'qemu-vm', uuid: 'uuid-qemu' });
  seedGuest(db, { cluster_id: 'c1', node: 'pve1', vmid: 200, type: 'lxc', name: 'web01', mac: 'bc:24:11:00:00:01' });
  seedHost(db, 'qemu-host');
  seedHost(db, 'lxc-host');
  seedHost(db, 'bare-host');

  // qemu hint
  handleIdentityHint(db, 'qemu-host', { virt_type: 'qemu', system_uuid: 'uuid-qemu', hostname: 'qemu-vm', primary_mac: null });
  let row = db.prepare(`SELECT proxmox_vmid FROM hosts WHERE host_id='qemu-host'`).get() as any;
  assert.equal(row.proxmox_vmid, 100);

  // lxc hint
  handleIdentityHint(db, 'lxc-host', { virt_type: 'lxc', system_uuid: null, hostname: 'web01', primary_mac: null });
  row = db.prepare(`SELECT proxmox_vmid FROM hosts WHERE host_id='lxc-host'`).get() as any;
  assert.equal(row.proxmox_vmid, 200);

  // bare hint - no link (skipped before matcher)
  handleIdentityHint(db, 'bare-host', { virt_type: 'bare' as any, system_uuid: null, hostname: 'bare', primary_mac: null });
  row = db.prepare(`SELECT proxmox_vmid FROM hosts WHERE host_id='bare-host'`).get() as any;
  assert.equal(row.proxmox_vmid, null);

  // Deferred match: hint before inventory
  seedHost(db, 'late-vm');
  rememberIdentityHint('late-vm', { virt_type: 'qemu', system_uuid: 'uuid-late', hostname: 'late-vm', primary_mac: null });
  handleIdentityHint(db, 'late-vm', { virt_type: 'qemu', system_uuid: 'uuid-late', hostname: 'late-vm', primary_mac: null });
  row = db.prepare(`SELECT proxmox_vmid FROM hosts WHERE host_id='late-vm'`).get() as any;
  assert.equal(row.proxmox_vmid, null);

  seedGuest(db, { cluster_id: 'c1', node: 'pve1', vmid: 300, type: 'qemu', name: 'late-vm', uuid: 'uuid-late' });
  rematchAllPendingHints(db);
  row = db.prepare(`SELECT proxmox_vmid FROM hosts WHERE host_id='late-vm'`).get() as any;
  assert.equal(row.proxmox_vmid, 300);
});
```

- [ ] **Step 2: Run + commit**

```bash
npx tsx --test tests/integration/identity-link.test.ts
```

Expected: PASS.

```bash
git add tests/integration/identity-link.test.ts
git commit -m "test: integration coverage for identity link lifecycle"
```

---

## Task 16: Manual UX test on vdev VM

This task has no code; document execution to verify the deploy works.

- [ ] **Step 1: Build + deploy hub + agents to vdev** (per memory `reference_insightd_ops`)

```bash
docker build -t insightd-hub:vdev -f hub/Dockerfile .
docker build -t insightd-agent:vdev -f agent/Dockerfile .
docker compose -f docker-compose.hub.yml -f docker-compose.hub.override.yml up -d hub agent agent-kingduck
k3d image import insightd-agent:vdev -c insightd-test
kubectl -n insightd set image ds/insightd-agent agent=insightd-agent:vdev
kubectl -n insightd delete pod -l app=insightd-agent
```

- [ ] **Step 2: Install in-guest agent on n8n VM**

SSH to `andreas@10.0.0.125` (per memory `reference_remote_hosts`). If an in-guest agent is already running, restart it to pick up new identity-hint code:

```bash
sshpass -p <pw> ssh andreas@10.0.0.125 "docker restart insightd-agent"
```

- [ ] **Step 3: Verify link in DB**

```bash
docker run --rm -v insightd_hub-data:/data alpine sh -c \
  "apk add -q sqlite && sqlite3 /data/insightd.db \"SELECT host_id, proxmox_node, proxmox_vmid, proxmox_guest_type FROM hosts WHERE proxmox_vmid IS NOT NULL\""
```

Expected: at least one row showing the n8n host linked to its PVE guest.

- [ ] **Step 4: Verify UI redirect**

Open `http://10.0.0.51:3000`, find the n8n PVE container row in the dashboard, click it. Confirm the URL changes to `/hosts/<n8n-host-id>` and the Hypervisor info card renders at the top of the page.

- [ ] **Step 5: Verify fallback when guest is stopped**

Stop the n8n VM via PVE UI. Wait for the next collection cycle (~5 min). Click the n8n PVE container row again. Confirm the page does NOT redirect (the in-guest agent isn't reporting), and the existing PVE-only container detail renders.

- [ ] **Step 6: Restart and verify re-link**

Restart the n8n VM. Wait ~30s for the in-guest agent to publish its hint. Confirm the link re-establishes (DB query from Step 3).

---

## Final commit + branch push

- [ ] **Step 1: Run full test suite one last time**

```bash
npm test && npm run typecheck
```

- [ ] **Step 2: Push branch**

```bash
git push origin feat/proxmox-guest-host-correlation
```

- [ ] **Step 3: Open PR**

```bash
gh pr create --title "Auto-correlate Proxmox guests with in-guest insightd agents" --body "$(cat <<'EOF'
## Summary
- Adds zero-config linking between PVE-reported guests and in-guest insightd agents
- Schema v51 migration: 4 new columns on `hosts`, 2 on `container_snapshots`
- New MQTT topic `insightd/<host>/identity-hint` (retained); hub matches against PVE inventory
- UI redirects PVE container detail to in-guest host detail + new Hypervisor info card
- Manual env-var bridge preserved for backward compat

See `docs/superpowers/specs/2026-05-09-proxmox-guest-host-correlation-design.md` for the full design.

## Test plan
- [ ] All new unit tests pass (identity-hint, matcher, MQTT handler, label override, deferred match)
- [ ] Integration test passes
- [ ] CI green
- [ ] Manual UX test on vdev: n8n VM links + redirects correctly; stopped guest falls back to PVE-only view; restart re-establishes link

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review notes (informational, not steps)

- Spec section "1. Architecture" → Tasks 5, 6 (agent), 7, 8 (hub)
- Spec section "2. Schema migration v51" → Task 1
- Spec section "3. PVE collector enrichment" → Tasks 2, 3, 4
- Spec section "4. Identity matcher" → Task 7
- Spec section "5. MQTT subscriber" → Tasks 8, 10
- Spec section "6. API extensions" → Task 11
- Spec section "7. ContainerDetailPage" → Task 12
- Spec section "8. HostDetailPage" → Task 13
- Spec section "9. HostsPage" → Task 13
- Spec section "10. Glossary" → Task 14
- Spec section "Edge cases" → covered across handler logic + tests in Tasks 7, 8, 9
- Spec section "Testing" → Tasks 1-15 each include their own tests; Task 15 = integration; Task 16 = manual UX
- Spec section "Migration & rollout" → Task 1 (idempotent ALTER); rollout = Task 16

All spec sections have at least one task. No placeholders remain.
