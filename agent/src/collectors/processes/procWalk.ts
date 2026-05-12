// agent/src/collectors/processes/procWalk.ts
import * as fs from 'fs';
import * as path from 'path';
import { hashArgv, joinArgv } from './argvHash';

const PF_KTHREAD = 0x00200000;
const CLK_TCK = 100;  // sysconf(_SC_CLK_TCK) is 100 on all Linux distros agent runs on

export interface ObservedProcess {
  pid: number;
  ppid: number;
  comm: string;
  argv: string;
  argvFull: string[];
  argvHash: string;
  startedAt: string;
  source: 'docker' | 'k8s' | 'host';
  containerId?: string;
  podUid?: string;
}

export interface ProcWalkOpts {
  procRoot: string;
  bootTimeMs: number;
  claimedPids: Set<number>;
  argvMaxBytes: number;
}

function parseStat(content: string): { ppid: number; flags: number; starttime: number; comm: string } | null {
  // The comm field is (parens-wrapped) and may contain spaces.
  // Strategy: take everything between the first '(' and last ')'.
  const open = content.indexOf('(');
  const close = content.lastIndexOf(')');
  if (open < 0 || close < 0) return null;
  const comm = content.slice(open + 1, close);
  const rest = content.slice(close + 2).split(' ');
  // After comm, fields are state(1) ppid(2) ... → rest[0]=state, rest[1]=ppid, ...
  // Field 9 (flags) is rest[6]; field 22 (starttime) is rest[19].
  const ppid = parseInt(rest[1], 10);
  const flags = parseInt(rest[6], 10);
  const starttime = parseInt(rest[19], 10);
  if (Number.isNaN(ppid) || Number.isNaN(flags) || Number.isNaN(starttime)) return null;
  return { ppid, flags, starttime, comm };
}

function readArgv(procRoot: string, pid: number): string[] | null {
  try {
    const raw = fs.readFileSync(path.join(procRoot, String(pid), 'cmdline'), 'utf8');
    if (!raw) return null;
    // NUL-separated, often trailing NUL.
    const parts = raw.split('\0').filter(s => s.length > 0);
    if (parts.length === 0) return null;
    return parts;
  } catch {
    return null;
  }
}

export function walkProc(opts: ProcWalkOpts): ObservedProcess[] {
  const out: ObservedProcess[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(opts.procRoot);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = parseInt(name, 10);
    if (opts.claimedPids.has(pid)) continue;

    let stat: ReturnType<typeof parseStat>;
    try {
      stat = parseStat(fs.readFileSync(path.join(opts.procRoot, name, 'stat'), 'utf8'));
    } catch {
      continue;
    }
    if (!stat) continue;
    if (stat.flags & PF_KTHREAD) continue;

    const argvFull = readArgv(opts.procRoot, pid);
    if (!argvFull) continue;

    const joined = joinArgv(argvFull);
    const argv = joined.length > opts.argvMaxBytes ? joined.slice(0, opts.argvMaxBytes) : joined;
    const argvHash = hashArgv(argvFull);
    const startedAtMs = opts.bootTimeMs + (stat.starttime / CLK_TCK) * 1000;
    out.push({
      pid,
      ppid: stat.ppid,
      comm: stat.comm,
      argv,
      argvFull,
      argvHash,
      startedAt: new Date(startedAtMs).toISOString(),
      source: 'host',
    });
  }
  return out;
}
