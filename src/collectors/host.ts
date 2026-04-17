import fs = require('fs');
import path = require('path');
import logger = require('../utils/logger');

interface HostConfig {
  hostRoot?: string;
}

interface MemoryInfo {
  totalMb: number;
  usedMb: number;
  availableMb: number;
  swapTotalMb: number | null;
  swapUsedMb: number | null;
}

interface LoadAvg {
  load1: number;
  load5: number;
  load15: number;
}

interface HostData {
  cpuPercent: number | null;
  memory: MemoryInfo | null;
  load: LoadAvg | null;
  uptimeSeconds: number | null;
}

let prevCpuTotals: { active: number; total: number } | null = null;

function parseProcNumber(value: string | undefined): number | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseMeminfoKb(meminfo: string, key: string): number | null {
  const match = meminfo.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundMb(kb: number): number {
  return Math.round(kb / 1024 * 100) / 100;
}

/**
 * Collect host-level system metrics from /proc.
 * Returns plain data object — no DB writes.
 */
function collectHost(config: HostConfig): HostData {
  const root = config.hostRoot || '/host';
  const procPath = path.join(root, 'proc');

  const cpuPercent = readCpu(procPath);
  const memory = readMemory(procPath);
  const load = readLoadAvg(procPath);
  const uptimeSeconds = readUptime(procPath);

  logger.info('host', `CPU=${cpuPercent ?? 'pending'}% MEM=${memory ? Math.round(memory.usedMb) : '?'}/${memory ? Math.round(memory.totalMb) : '?'}MB Load=${load ? load.load1 : '?'}`);

  return { cpuPercent, memory, load, uptimeSeconds };
}

function readCpu(procPath: string): number | null {
  try {
    const stat = fs.readFileSync(path.join(procPath, 'stat'), 'utf8');
    const line = stat.split('\n').find(l => l.startsWith('cpu '));
    if (!line) return null;

    const rawParts = line.trim().split(/\s+/).slice(1).map(value => parseProcNumber(value));
    const parts = rawParts.filter((value): value is number => value != null);
    if (parts.length < 5 || parts.length !== rawParts.length) return null;
    // user, nice, system, idle, iowait, irq, softirq, steal
    const idle = parts[3] + parts[4];
    const total = parts.reduce((sum, value) => sum + value, 0);
    const active = total - idle;
    if (!Number.isFinite(idle) || !Number.isFinite(total) || !Number.isFinite(active) || active < 0) return null;

    if (!prevCpuTotals) {
      prevCpuTotals = { active, total };
      return null;
    }

    const activeDelta = active - prevCpuTotals.active;
    const totalDelta = total - prevCpuTotals.total;
    prevCpuTotals = { active, total };

    if (!Number.isFinite(activeDelta) || !Number.isFinite(totalDelta) || activeDelta < 0 || totalDelta <= 0 || activeDelta > totalDelta) return null;
    return Math.round((activeDelta / totalDelta) * 100 * 100) / 100;
  } catch {
    return null;
  }
}

function readMemory(procPath: string): MemoryInfo | null {
  try {
    const meminfo = fs.readFileSync(path.join(procPath, 'meminfo'), 'utf8');
    const totalKb = parseMeminfoKb(meminfo, 'MemTotal');
    const availableKb = parseMeminfoKb(meminfo, 'MemAvailable');
    if (totalKb == null || availableKb == null || availableKb > totalKb) return null;

    const swapTotalKb = parseMeminfoKb(meminfo, 'SwapTotal');
    const swapFreeKb = parseMeminfoKb(meminfo, 'SwapFree');
    const swapTotalMb = swapTotalKb == null ? null : roundMb(swapTotalKb);
    const swapUsedMb = swapTotalKb == null || swapFreeKb == null || swapFreeKb > swapTotalKb
      ? null
      : roundMb(swapTotalKb - swapFreeKb);

    return {
      totalMb: roundMb(totalKb),
      usedMb: roundMb(totalKb - availableKb),
      availableMb: roundMb(availableKb),
      swapTotalMb,
      swapUsedMb,
    };
  } catch {
    return null;
  }
}

function readLoadAvg(procPath: string): LoadAvg | null {
  try {
    const content = fs.readFileSync(path.join(procPath, 'loadavg'), 'utf8');
    const parts = content.trim().split(/\s+/);
    const load1 = parseProcNumber(parts[0]);
    const load5 = parseProcNumber(parts[1]);
    const load15 = parseProcNumber(parts[2]);
    if (load1 == null || load5 == null || load15 == null) return null;

    return {
      load1,
      load5,
      load15,
    };
  } catch {
    return null;
  }
}

function readUptime(procPath: string): number | null {
  try {
    const content = fs.readFileSync(path.join(procPath, 'uptime'), 'utf8');
    const value = parseProcNumber(content.trim().split(/\s+/)[0]);
    if (value == null || value < 0) return null;
    return value;
  } catch {
    return null;
  }
}

function _resetPrevCpu(): void { prevCpuTotals = null; }

module.exports = { collectHost, _resetPrevCpu };
