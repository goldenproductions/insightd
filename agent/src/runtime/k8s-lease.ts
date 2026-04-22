import logger = require('../../../shared/utils/logger');
import type { K8sClient, K8sLease } from './kubernetes';

export interface LeaderElectorOptions {
  client: K8sClient;
  namespace: string;
  leaseName: string;
  identity: string;
  leaseDurationSec?: number;
  renewIntervalSec?: number;
  acquireIntervalSec?: number;
}

export interface LeaderElector {
  isLeader(): boolean;
  start(): void;
  stop(): Promise<void>;
}

/**
 * Pure function: is the Lease expired based on the server-provided renewTime
 * plus leaseDurationSeconds? Extracted for unit testability.
 */
export function isLeaseExpired(lease: K8sLease, nowMs: number = Date.now()): boolean {
  const renew = lease.spec?.renewTime;
  const dur = lease.spec?.leaseDurationSeconds ?? 15;
  if (!renew) return true;
  const renewMs = Date.parse(renew);
  if (Number.isNaN(renewMs)) return true;
  return (nowMs - renewMs) > dur * 1000;
}

/**
 * K8s Lease acquireTime/renewTime use `MicroTime` (6 fractional digits of
 * seconds). JS `toISOString()` produces 3 (millis), which the API server
 * rejects with 400. Pad the fractional part to 6 digits.
 */
function microTime(now: Date = new Date()): string {
  return now.toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
}

/**
 * Kubernetes Lease-based leader election. Exactly one holder across the cluster.
 *
 * State machine:
 *   STANDBY --acquire--> LEADER (periodic renew)
 *   LEADER  --renew fails / conflict --> STANDBY
 *
 * We acquire when the Lease doesn't exist (404 → POST), or when it exists but
 * has expired based on its own server-provided `renewTime`. On handoff we PUT
 * a release (holderIdentity = null) so the next candidate takes over within
 * one tick instead of waiting out the full `leaseDurationSec`.
 */
export function createLeaderElector(opts: LeaderElectorOptions): LeaderElector {
  const {
    client,
    namespace,
    leaseName,
    identity,
    leaseDurationSec = 15,
    renewIntervalSec = 5,
    acquireIntervalSec = 10,
  } = opts;

  let leader = false;
  let currentResourceVersion: string | undefined;
  let renewTimer: ReturnType<typeof setInterval> | null = null;
  let acquireTimer: ReturnType<typeof setInterval> | null = null;
  let leaseTransitions = 0;
  let stopped = false;

  function buildLease(isNew: boolean, prev?: K8sLease): K8sLease {
    const now = microTime();
    return {
      apiVersion: 'coordination.k8s.io/v1',
      kind: 'Lease',
      metadata: {
        name: leaseName,
        namespace,
        ...(prev?.metadata?.resourceVersion ? { resourceVersion: prev.metadata.resourceVersion } : {}),
      },
      spec: {
        holderIdentity: identity,
        leaseDurationSeconds: leaseDurationSec,
        acquireTime: isNew ? now : (prev?.spec?.acquireTime ?? now),
        renewTime: now,
        leaseTransitions: isNew ? leaseTransitions + 1 : (prev?.spec?.leaseTransitions ?? 0),
      },
    };
  }

  async function tryAcquire(): Promise<void> {
    if (stopped || leader) return;
    try {
      const existing = await client.getLease(namespace, leaseName);
      if (!existing) {
        // No lease — create it. 409 = someone raced us.
        const res = await client.createLease(namespace, buildLease(true));
        if (res.status === 201 || res.status === 200) {
          currentResourceVersion = res.body?.metadata?.resourceVersion;
          becomeLeader();
          logger.info('lease', `Acquired ${leaseName} (created)`);
        } else if (res.status === 409) {
          logger.info('lease', `Acquire race lost (conflict on create)`);
        } else {
          logger.warn('lease', `Create lease returned ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
        }
        return;
      }

      if (existing.spec?.holderIdentity === identity) {
        // We somehow already own it (restart after crash?). Adopt it.
        currentResourceVersion = existing.metadata?.resourceVersion;
        becomeLeader();
        logger.info('lease', `Re-adopted ${leaseName}`);
        return;
      }

      if (isLeaseExpired(existing)) {
        // Steal the expired lease.
        leaseTransitions = existing.spec?.leaseTransitions ?? 0;
        const res = await client.updateLease(namespace, leaseName, buildLease(true, existing));
        if (res.status === 200) {
          currentResourceVersion = res.body?.metadata?.resourceVersion;
          becomeLeader();
          logger.info('lease', `Stole expired ${leaseName} from ${existing.spec?.holderIdentity ?? '<none>'}`);
        } else if (res.status === 409) {
          logger.info('lease', `Steal race lost (conflict on update)`);
        } else {
          logger.warn('lease', `Steal lease returned ${res.status}`);
        }
      }
      // Otherwise: valid lease held by another pod. Stay standby.
    } catch (err) {
      logger.warn('lease', `Acquire attempt failed: ${(err as Error).message}`);
    }
  }

  async function tryRenew(): Promise<void> {
    if (stopped || !leader) return;
    try {
      const existing = await client.getLease(namespace, leaseName);
      if (!existing || existing.spec?.holderIdentity !== identity) {
        // We lost it somehow (evicted, another pod took over after clock skew)
        logger.warn('lease', `Lost ${leaseName} — holder is now ${existing?.spec?.holderIdentity ?? '<none>'}`);
        stepDown();
        return;
      }
      currentResourceVersion = existing.metadata?.resourceVersion;
      const res = await client.updateLease(namespace, leaseName, buildLease(false, existing));
      if (res.status === 200) {
        currentResourceVersion = res.body?.metadata?.resourceVersion;
      } else if (res.status === 409) {
        logger.warn('lease', `Renew conflict on ${leaseName} — stepping down`);
        stepDown();
      } else {
        logger.warn('lease', `Renew returned ${res.status} — stepping down`);
        stepDown();
      }
    } catch (err) {
      logger.warn('lease', `Renew failed: ${(err as Error).message}`);
      // Don't step down on transient network errors — next tick will retry.
      // If we're truly disconnected, the lease expires server-side and
      // another agent steals it within leaseDurationSec.
    }
  }

  function becomeLeader(): void {
    leader = true;
  }

  function stepDown(): void {
    leader = false;
    currentResourceVersion = undefined;
  }

  return {
    isLeader: () => leader,

    start(): void {
      if (stopped) throw new Error('Cannot start a stopped LeaderElector');
      void tryAcquire();
      acquireTimer = setInterval(() => { void tryAcquire(); }, acquireIntervalSec * 1000);
      renewTimer = setInterval(() => { void tryRenew(); }, renewIntervalSec * 1000);
    },

    async stop(): Promise<void> {
      stopped = true;
      if (acquireTimer) clearInterval(acquireTimer);
      if (renewTimer) clearInterval(renewTimer);
      acquireTimer = null;
      renewTimer = null;

      if (!leader) return;
      // Best-effort release so handoff is near-instant.
      try {
        const existing = await client.getLease(namespace, leaseName);
        if (existing && existing.spec?.holderIdentity === identity) {
          await client.updateLease(namespace, leaseName, {
            apiVersion: 'coordination.k8s.io/v1',
            kind: 'Lease',
            metadata: { name: leaseName, namespace, resourceVersion: existing.metadata?.resourceVersion },
            spec: {
              ...existing.spec,
              holderIdentity: null,
              renewTime: microTime(),
            },
          });
          logger.info('lease', `Released ${leaseName}`);
        }
      } catch (err) {
        logger.warn('lease', `Release failed: ${(err as Error).message}`);
      }
      leader = false;
    },
  };
}
