import fs = require('fs');
import path = require('path');
import logger = require('../../../shared/utils/logger');

interface HostConfig {
  hostRoot?: string;
}

interface MemoryInfo {
  totalMb: number | null;
  usedMb: number | null;
  availableMb: number | null;
  swapTotalMb: number | null;
  swapUsedMb: number | null;
}

interface LoadAvg {
  load1: number | null;
  load5: number | null;
  load15: number | null;
}

interface HostData {
  cpuPercent: number | null;
  memory: MemoryInfo | null;
  load: LoadAvg | null;
  uptimeSeconds: number | null;
}

let prevCpuTotals: { active: number; total: number } | null = null;

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

  logger.info('host', `CPU=${cpuPercent ?? 'pending'}% MEM=${memory?.usedMb != null ? Math.round(memory.usedMb) : '?'}/${memory?.totalMb != null ? Math.round(memory.totalMb) : '?'}MB Load=${load?.load1 ?? '?'}`);

  return { cpuPercent, memory, load, uptimeSeconds };
}

function readCpu(procPath: string): number | null {
  try {
    const stat = fs.readFileSync(path.join(procPath, 'stat'), 'utf8');
    const line = stat.split('\n').find(l => l.startsWith('cpu '));
    if (!line) return null;

    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    // user, nice, system, idle, iowait, irq, softirq, steal
    const idle = parts[3] + (parts[4] || 0);
    const total = parts.reduce((a, b) => a + b, 0);
    const active = total - idle;

    if (!prevCpuTotals) {
      prevCpuTotals = { active, total };
      return null;
    }

    const activeDelta = active - prevCpuTotals.active;
    const totalDelta = total - prevCpuTotals.total;
    prevCpuTotals = { active, total };

    if (totalDelta <= 0) return null;
    return Math.round((activeDelta / totalDelta) * 100 * 100) / 100;
  } catch {
    return null;
  }
}

function readMemory(procPath: string): MemoryInfo | null {
  try {
    const meminfo = fs.readFileSync(path.join(procPath, 'meminfo'), 'utf8');
    const get = (key: string): number => {
      const match = meminfo.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
      return match ? parseInt(match[1], 10) : 0;
    };

    const totalKb = get('MemTotal');
    const availableKb = get('MemAvailable');
    const swapTotalKb = get('SwapTotal');
    const swapFreeKb = get('SwapFree');

    return {
      totalMb: Math.round(totalKb / 1024 * 100) / 100,
      usedMb: Math.round((totalKb - availableKb) / 1024 * 100) / 100,
      availableMb: Math.round(availableKb / 1024 * 100) / 100,
      swapTotalMb: Math.round(swapTotalKb / 1024 * 100) / 100,
      swapUsedMb: Math.round((swapTotalKb - swapFreeKb) / 1024 * 100) / 100,
    };
  } catch {
    return null;
  }
}

function readLoadAvg(procPath: string): LoadAvg | null {
  try {
    const content = fs.readFileSync(path.join(procPath, 'loadavg'), 'utf8');
    const parts = content.trim().split(/\s+/);
    return {
      load1: parseFloat(parts[0]),
      load5: parseFloat(parts[1]),
      load15: parseFloat(parts[2]),
    };
  } catch {
    return null;
  }
}

function readUptime(procPath: string): number | null {
  try {
    const content = fs.readFileSync(path.join(procPath, 'uptime'), 'utf8');
    const value = parseFloat(content.trim().split(/\s+/)[0]);
    // Guard against LXC/Proxmox overflow where /proc/uptime returns negative or absurd values
    if (!isFinite(value) || value < 0 || value > 315360000) return null; // max ~10 years
    return value;
  } catch {
    return null;
  }
}

function _resetPrevCpu(): void { prevCpuTotals = null; }

module.exports = { collectHost, _resetPrevCpu };
