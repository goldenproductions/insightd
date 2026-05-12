// agent/src/collectors/processes/dockerTop.ts
import { hashArgv, joinArgv } from './argvHash';
import type { ObservedProcess } from './procWalk';
import logger = require('../../../../shared/utils/logger');

interface DockerTopResult {
  Titles?: string[] | null;
  Processes?: string[][] | null;
}

export function parseDockerTop(res: DockerTopResult): {
  pid: number; ppid: number; comm: string; argvFull: string[];
}[] {
  if (!res.Processes || res.Processes.length === 0) return [];
  const titles = (res.Titles ?? []).map(t => t.toUpperCase());
  const pidIdx = titles.indexOf('PID');
  const ppidIdx = titles.indexOf('PPID');
  const commIdx = titles.indexOf('COMM');
  const argsIdx = titles.indexOf('ARGS');
  if (pidIdx < 0 || ppidIdx < 0 || argsIdx < 0) return [];
  const out = [];
  for (const row of res.Processes) {
    const pid = parseInt(row[pidIdx], 10);
    const ppid = parseInt(row[ppidIdx], 10);
    const comm = commIdx >= 0 ? row[commIdx] : '';
    const argvFull = row[argsIdx].split(/\s+/).filter(s => s.length > 0);
    if (Number.isNaN(pid) || argvFull.length === 0) continue;
    out.push({ pid, ppid, comm, argvFull });
  }
  return out;
}

export interface DockerTopOpts {
  timeoutMs: number;
  bootTimeMs: number;            // reserved for future startedAt derivation; currently unused
  argvMaxBytes: number;
}

export async function viaDockerTop(
  docker: any,                   // dockerode-like; minimal surface = getContainer(id).top()
  containers: Array<{ Id: string; Names: string[] }>,
  opts: DockerTopOpts,
): Promise<Map<number, ObservedProcess>> {
  const now = new Date().toISOString();   // startedAt unknown via docker top; use observation time

  const results = await Promise.allSettled(containers.map(c => {
    const inst = docker.getContainer(c.Id);
    return Promise.race([
      inst.top().then((r: DockerTopResult) => ({ c, r })),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`docker top timeout for ${c.Id}`)), opts.timeoutMs),
      ),
    ]);
  }));

  const map = new Map<number, ObservedProcess>();
  for (const r of results) {
    if (r.status === 'rejected') {
      logger.warn('processes', String((r.reason as Error)?.message ?? r.reason));
      continue;
    }
    const { c, r: top } = r.value as any;
    for (const proc of parseDockerTop(top)) {
      const joined = joinArgv(proc.argvFull);
      const argv = joined.length > opts.argvMaxBytes ? joined.slice(0, opts.argvMaxBytes) : joined;
      map.set(proc.pid, {
        pid: proc.pid,
        ppid: proc.ppid,
        comm: proc.comm,
        argv,
        argvFull: proc.argvFull,
        argvHash: hashArgv(proc.argvFull),
        startedAt: now,
        source: 'docker',
        containerId: c.Id,
      });
    }
  }
  return map;
}
