// agent/src/collectors/processes/crictl.ts
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { hashArgv, joinArgv } from './argvHash';
import type { ObservedProcess } from './procWalk';
import logger = require('../../../../shared/utils/logger');

export interface CrictlOpts {
  runtime: 'docker' | 'kubernetes' | 'auto';
  crictlAvailable: boolean;
  procRoot: string;
  bootTimeMs: number;
  argvMaxBytes: number;
}

export async function isCrictlAvailable(deps?: { whichSync?: () => string }): Promise<boolean> {
  const which = deps?.whichSync ?? (() =>
    execFileSync('which', ['crictl'], { encoding: 'utf8' }).trim());
  try {
    const out = which();
    return out.length > 0;
  } catch {
    return false;
  }
}

interface CrictlPodSandbox { id: string; metadata?: { uid?: string } }

function listPods(): CrictlPodSandbox[] {
  try {
    const out = execFileSync('crictl', ['pods', '-o', 'json'], { encoding: 'utf8' });
    const parsed = JSON.parse(out);
    return parsed.items ?? [];
  } catch (err) {
    logger.warn('processes', `crictl pods failed: ${(err as Error).message}`);
    return [];
  }
}

function inspectPodRootPid(podId: string): number | null {
  try {
    const out = execFileSync('crictl', ['inspectp', '-o', 'json', podId], { encoding: 'utf8' });
    const parsed = JSON.parse(out);
    const pid = parsed?.info?.pid ?? parsed?.pid;
    return typeof pid === 'number' ? pid : null;
  } catch {
    return null;
  }
}

function readDescendantPids(procRoot: string, rootPid: number): number[] {
  const pids = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const p = queue.shift()!;
    const tasksDir = path.join(procRoot, String(p), 'task');
    let tasks: string[] = [];
    try { tasks = fs.readdirSync(tasksDir); } catch { continue; }
    for (const t of tasks) {
      const childrenFile = path.join(tasksDir, t, 'children');
      try {
        const raw = fs.readFileSync(childrenFile, 'utf8').trim();
        if (!raw) continue;
        for (const c of raw.split(/\s+/)) {
          const n = parseInt(c, 10);
          if (!Number.isNaN(n) && !pids.has(n)) {
            pids.add(n);
            queue.push(n);
          }
        }
      } catch { /* /proc race or perm; skip */ }
    }
  }
  return [...pids];
}

export async function viaCrictl(opts: CrictlOpts): Promise<Map<number, ObservedProcess>> {
  const map = new Map<number, ObservedProcess>();
  if (opts.runtime !== 'kubernetes') return map;
  if (!opts.crictlAvailable) return map;

  const pods = listPods();
  for (const pod of pods) {
    const rootPid = inspectPodRootPid(pod.id);
    if (rootPid === null) continue;
    const descendants = readDescendantPids(opts.procRoot, rootPid);
    for (const pid of descendants) {
      let argvFull: string[] | null = null;
      try {
        const raw = fs.readFileSync(path.join(opts.procRoot, String(pid), 'cmdline'), 'utf8');
        argvFull = raw.split('\0').filter(s => s.length > 0);
      } catch { continue; }
      if (!argvFull || argvFull.length === 0) continue;
      const joined = joinArgv(argvFull);
      const argv = joined.length > opts.argvMaxBytes ? joined.slice(0, opts.argvMaxBytes) : joined;
      map.set(pid, {
        pid,
        ppid: 0,    // not parsed here; consumers don't require ppid for k8s-source rows in v1
        comm: argvFull[0].split('/').pop() ?? '',
        argv,
        argvFull,
        argvHash: hashArgv(argvFull),
        startedAt: new Date().toISOString(),
        source: 'k8s',
        podUid: pod.metadata?.uid,
      });
    }
  }
  return map;
}
