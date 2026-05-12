// tests/unit/agent-proc-walk.test.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
const { walkProc } = require('../../agent/src/collectors/processes/procWalk');

let tmpProc: string;

function makeProc(pid: number, opts: {
  ppid: number; comm: string; cmdline: string[]; kthread?: boolean;
  starttimeJiffies?: number;
}) {
  const dir = path.join(tmpProc, String(pid));
  fs.mkdirSync(dir, { recursive: true });
  // /proc/<pid>/stat — 52 fields. We need only fields 1-22.
  // Field 3 = state (R/S/Z/...); field 4 = ppid; field 9 = flags;
  // PF_KTHREAD = 0x00200000; field 22 = starttime jiffies.
  const flags = opts.kthread ? 0x00200000 : 0;
  const fields = [
    pid, `(${opts.comm})`, 'S', opts.ppid, 0, 0, 0, 0, flags,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, opts.starttimeJiffies ?? 1000,
  ];
  while (fields.length < 52) fields.push(0);
  fs.writeFileSync(path.join(dir, 'stat'), fields.join(' '));
  fs.writeFileSync(path.join(dir, 'cmdline'), opts.cmdline.join('\0') + '\0');
}

describe('walkProc', () => {
  before(() => {
    tmpProc = fs.mkdtempSync(path.join(os.tmpdir(), 'procwalk-'));
    makeProc(100, { ppid: 1, comm: 'sshd', cmdline: ['/usr/sbin/sshd', '-D'] });
    makeProc(101, { ppid: 100, comm: 'bash', cmdline: ['bash'] });
    makeProc(2, { ppid: 0, comm: 'kthreadd', cmdline: [], kthread: true });
    fs.mkdirSync(path.join(tmpProc, 'self'));
    fs.writeFileSync(path.join(tmpProc, 'uptime'), '1.0 1.0\n');
  });
  after(() => fs.rmSync(tmpProc, { recursive: true, force: true }));

  it('returns non-kthread processes only', () => {
    const procs = walkProc({
      procRoot: tmpProc, bootTimeMs: 0,
      claimedPids: new Set(), argvMaxBytes: 4096,
    });
    const pids = procs.map((p: any) => p.pid).sort((a: number, b: number) => a - b);
    assert.deepEqual(pids, [100, 101]);
  });

  it('skips claimed PIDs', () => {
    const procs = walkProc({
      procRoot: tmpProc, bootTimeMs: 0,
      claimedPids: new Set([101]), argvMaxBytes: 4096,
    });
    assert.deepEqual(procs.map((p: any) => p.pid), [100]);
  });

  it('parses cmdline with NUL separators into argv array', () => {
    const procs = walkProc({
      procRoot: tmpProc, bootTimeMs: 0,
      claimedPids: new Set(), argvMaxBytes: 4096,
    });
    const sshd = procs.find((p: any) => p.pid === 100)!;
    assert.deepEqual(sshd.argvFull, ['/usr/sbin/sshd', '-D']);
    assert.equal(sshd.argv, '/usr/sbin/sshd -D');
  });

  it('truncates argv string to argvMaxBytes, but hash uses full argv', () => {
    const longArgv = ['x', 'a'.repeat(8000)];
    makeProc(200, { ppid: 1, comm: 'big', cmdline: longArgv });
    const procs = walkProc({
      procRoot: tmpProc, bootTimeMs: 0,
      claimedPids: new Set(), argvMaxBytes: 4096,
    });
    const big = procs.find((p: any) => p.pid === 200)!;
    assert.equal(big.argv.length, 4096);
    assert.equal(big.argvFull[1].length, 8000);
  });

  it('omits processes with empty cmdline (kthread or race)', () => {
    makeProc(300, { ppid: 1, comm: 'empty', cmdline: [] });
    const procs = walkProc({
      procRoot: tmpProc, bootTimeMs: 0,
      claimedPids: new Set(), argvMaxBytes: 4096,
    });
    assert.equal(procs.find((p: any) => p.pid === 300), undefined);
  });
});
