// agent/src/collectors/processes/poller.ts
import type { ObservedProcess } from './procWalk';
import type {
  ArgvDef, SpawnEvent, ExitEvent, ProcessEventPayload,
} from '../../../../shared/types/process-events';

export interface PollerDeps {
  collectDocker: () => Promise<Map<number, ObservedProcess>>;
  collectK8s:    () => Promise<Map<number, ObservedProcess>>;
  collectHost:   (claimed: Set<number>) => ObservedProcess[];
  now: () => Date;
}

export interface PollerState {
  prevKeyToProc: Map<string, ObservedProcess>;
  shippedHashes: Set<string>;
  /** epoch ms when each key was first observed — used as fallback start time */
  firstSeenMs: Map<string, number>;
}

export function newState(): PollerState {
  return { prevKeyToProc: new Map(), shippedHashes: new Set(), firstSeenMs: new Map() };
}

export function makeKey(pid: number, startedAt: string): string {
  return `${pid}:${startedAt}`;
}

export async function runPollCycle(
  state: PollerState,
  deps: PollerDeps,
): Promise<ProcessEventPayload> {
  const dockerMap = await deps.collectDocker();
  const k8sMap = await deps.collectK8s();
  const claimed = new Set<number>([...dockerMap.keys(), ...k8sMap.keys()]);
  const hostList = deps.collectHost(claimed);

  const current = new Map<string, ObservedProcess>();
  for (const p of dockerMap.values()) current.set(makeKey(p.pid, p.startedAt), p);
  for (const p of k8sMap.values()) current.set(makeKey(p.pid, p.startedAt), p);
  for (const p of hostList) current.set(makeKey(p.pid, p.startedAt), p);

  const spawns: SpawnEvent[] = [];
  const exits: ExitEvent[] = [];
  const argv_defs: ArgvDef[] = [];

  const nowMs = deps.now().getTime();

  for (const [key, p] of current) {
    if (!state.prevKeyToProc.has(key)) {
      // Record first-seen time for this key
      if (!state.firstSeenMs.has(key)) {
        state.firstSeenMs.set(key, nowMs);
      }
      spawns.push({
        pid: p.pid,
        ppid: p.ppid,
        argv_hash: p.argvHash,
        started_at: p.startedAt,
        source: p.source,
        container_id: p.containerId,
        pod_uid: p.podUid,
      });
      if (!state.shippedHashes.has(p.argvHash)) {
        argv_defs.push({ argv_hash: p.argvHash, argv: p.argv, comm: p.comm });
        state.shippedHashes.add(p.argvHash);
      }
    }
  }

  for (const [key, prev] of state.prevKeyToProc) {
    if (!current.has(key)) {
      const parsedStartMs = Date.parse(prev.startedAt);
      const startMs = Number.isNaN(parsedStartMs)
        ? (state.firstSeenMs.get(key) ?? nowMs)
        : parsedStartMs;
      exits.push({
        pid: prev.pid,
        started_at: prev.startedAt,
        exited_at: deps.now().toISOString(),
        exit_code: null,
        lifetime_ms: Math.max(0, nowMs - startMs),
      });
      state.firstSeenMs.delete(key);
    }
  }

  state.prevKeyToProc = current;

  return {
    cycle_at: deps.now().toISOString(),
    argv_defs,
    spawns,
    exits,
  };
}
