import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const fs = require('fs');

const originalReadFileSync = fs.readFileSync;

describe('collectHost', () => {
  let collectHost: Function, standaloneCollectHost: Function;
  let _resetPrevCpu: Function, standaloneResetPrevCpu: Function;
  let mockFiles: Record<string, string> = {};

  const config = { hostRoot: '/host' };
  const procFile = (name: string): string => path.join(config.hostRoot, 'proc', name);
  const setValidProcFiles = (): void => {
    mockFiles[procFile('meminfo')] = 'MemTotal: 8000000 kB\nMemAvailable: 4000000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n';
    mockFiles[procFile('loadavg')] = '0.50 0.75 1.00 2/300 12345\n';
    mockFiles[procFile('uptime')] = '86400.50 172800.00\n';
  };

  beforeEach(() => {
    mockFiles = {};
    mock.method(fs, 'readFileSync', (filePath: string | Buffer, encoding?: string) => {
      const resolvedPath = filePath.toString();
      if (mockFiles[resolvedPath] !== undefined) return mockFiles[resolvedPath];
      return originalReadFileSync(filePath, encoding);
    });

    delete require.cache[require.resolve('../../agent/src/collectors/host')];
    delete require.cache[require.resolve('../../src/collectors/host')];
    const agentMod = require('../../agent/src/collectors/host');
    const standaloneMod = require('../../src/collectors/host');
    collectHost = agentMod.collectHost;
    standaloneCollectHost = standaloneMod.collectHost;
    _resetPrevCpu = agentMod._resetPrevCpu;
    standaloneResetPrevCpu = standaloneMod._resetPrevCpu;
    _resetPrevCpu();
    standaloneResetPrevCpu();
  });

  afterEach(() => {
    mock.restoreAll();
    _resetPrevCpu();
    standaloneResetPrevCpu();
  });

  it('returns null CPU on first call', () => {
    mockFiles[procFile('stat')] = 'cpu  100 20 30 400 10 5 3 2\n';
    mockFiles[procFile('meminfo')] = 'MemTotal: 8000000 kB\nMemAvailable: 4000000 kB\nSwapTotal: 2000000 kB\nSwapFree: 1500000 kB\n';
    mockFiles[procFile('loadavg')] = '0.50 0.75 1.00 2/300 12345\n';
    mockFiles[procFile('uptime')] = '86400.50 172800.00\n';

    const result = collectHost(config);
    assert.equal(result.cpuPercent, null);
  });

  it('calculates CPU percent from delta on second call', () => {
    mockFiles[procFile('stat')] = 'cpu  100 20 30 400 10 5 3 2\n';
    setValidProcFiles();
    collectHost(config);

    mockFiles[procFile('stat')] = 'cpu  150 20 30 450 10 5 3 2\n';
    const result = collectHost(config);
    assert.equal(result.cpuPercent, 50);
  });

  it('returns null CPU for malformed stat input without poisoning the next valid sample', () => {
    mockFiles[procFile('stat')] = 'cpu  100 20 30 400 10 5 3 2\n';
    setValidProcFiles();
    collectHost(config);

    mockFiles[procFile('stat')] = 'cpu  150 20 nope 450 10 5 3 2\n';
    let result = collectHost(config);
    assert.equal(result.cpuPercent, null);

    mockFiles[procFile('stat')] = 'cpu  160 20 30 460 10 5 3 2\n';
    result = collectHost(config);
    assert.equal(result.cpuPercent, 50);
  });

  it('returns null CPU when counters reset', () => {
    mockFiles[procFile('stat')] = 'cpu  100 20 30 400 10 5 3 2\n';
    setValidProcFiles();
    collectHost(config);

    mockFiles[procFile('stat')] = 'cpu  90 20 30 350 10 5 3 2\n';
    const result = collectHost(config);
    assert.equal(result.cpuPercent, null);
  });

  it('parses memory info correctly', () => {
    mockFiles[procFile('stat')] = 'cpu  100 20 30 400 10 5 3 2\n';
    mockFiles[procFile('meminfo')] = 'MemTotal: 16384000 kB\nMemAvailable: 8192000 kB\nSwapTotal: 4096000 kB\nSwapFree: 2048000 kB\n';
    mockFiles[procFile('loadavg')] = '1.00 2.00 3.00 2/300 12345\n';
    mockFiles[procFile('uptime')] = '3600.00 7200.00\n';

    const result = collectHost(config);
    assert.equal(result.memory?.totalMb, 16000);
    assert.equal(result.memory?.usedMb, 8000);
    assert.equal(result.memory?.availableMb, 8000);
    assert.equal(result.memory?.swapTotalMb, 4000);
    assert.equal(result.memory?.swapUsedMb, 2000);
  });

  it('returns null memory when MemTotal is missing', () => {
    mockFiles[procFile('stat')] = 'cpu  100 20 30 400 10 5 3 2\n';
    mockFiles[procFile('meminfo')] = 'MemAvailable: 4000000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n';
    mockFiles[procFile('loadavg')] = '0.50 0.75 1.00 2/300 12345\n';
    mockFiles[procFile('uptime')] = '86400.50 172800.00\n';

    const result = collectHost(config);
    assert.equal(result.memory, null);
  });

  it('returns null memory when MemAvailable is missing', () => {
    mockFiles[procFile('stat')] = 'cpu  100 20 30 400 10 5 3 2\n';
    mockFiles[procFile('meminfo')] = 'MemTotal: 8000000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n';
    mockFiles[procFile('loadavg')] = '0.50 0.75 1.00 2/300 12345\n';
    mockFiles[procFile('uptime')] = '86400.50 172800.00\n';

    const result = collectHost(config);
    assert.equal(result.memory, null);
  });

  it('keeps swap values null when swap fields are missing', () => {
    mockFiles[procFile('stat')] = 'cpu  100 20 30 400 10 5 3 2\n';
    mockFiles[procFile('meminfo')] = 'MemTotal: 16384000 kB\nMemAvailable: 8192000 kB\n';
    mockFiles[procFile('loadavg')] = '0.50 0.75 1.00 2/300 12345\n';
    mockFiles[procFile('uptime')] = '86400.50 172800.00\n';

    const result = collectHost(config);
    assert.equal(result.memory?.totalMb, 16000);
    assert.equal(result.memory?.swapTotalMb, null);
    assert.equal(result.memory?.swapUsedMb, null);
  });

  it('parses load average', () => {
    mockFiles[procFile('stat')] = 'cpu  100 20 30 400 10 5 3 2\n';
    mockFiles[procFile('meminfo')] = 'MemTotal: 8000000 kB\nMemAvailable: 4000000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n';
    mockFiles[procFile('loadavg')] = '1.50 2.75 3.25 5/400 99999\n';
    mockFiles[procFile('uptime')] = '86400.50 172800.00\n';

    const result = collectHost(config);
    assert.equal(result.load?.load1, 1.5);
    assert.equal(result.load?.load5, 2.75);
    assert.equal(result.load?.load15, 3.25);
  });

  it('returns null load for malformed loadavg input', () => {
    mockFiles[procFile('stat')] = 'cpu  100 20 30 400 10 5 3 2\n';
    mockFiles[procFile('meminfo')] = 'MemTotal: 8000000 kB\nMemAvailable: 4000000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n';
    mockFiles[procFile('loadavg')] = '1.50 nope 3.25 5/400 99999\n';
    mockFiles[procFile('uptime')] = '86400.50 172800.00\n';

    const result = collectHost(config);
    assert.equal(result.load, null);
  });

  it('parses uptime', () => {
    mockFiles[procFile('stat')] = 'cpu  100 20 30 400 10 5 3 2\n';
    mockFiles[procFile('meminfo')] = 'MemTotal: 8000000 kB\nMemAvailable: 4000000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n';
    mockFiles[procFile('loadavg')] = '0.50 0.75 1.00 2/300 12345\n';
    mockFiles[procFile('uptime')] = '86400.50 172800.00\n';

    const result = collectHost(config);
    assert.equal(result.uptimeSeconds, 86400.5);
  });

  it('returns null uptime for malformed and negative values', () => {
    mockFiles[procFile('stat')] = 'cpu  100 20 30 400 10 5 3 2\n';
    mockFiles[procFile('meminfo')] = 'MemTotal: 8000000 kB\nMemAvailable: 4000000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n';
    mockFiles[procFile('loadavg')] = '0.50 0.75 1.00 2/300 12345\n';
    mockFiles[procFile('uptime')] = 'not-a-number 172800.00\n';

    let result = collectHost(config);
    assert.equal(result.uptimeSeconds, null);

    mockFiles[procFile('uptime')] = '-1 172800.00\n';
    result = collectHost(config);
    assert.equal(result.uptimeSeconds, null);
  });

  it('accepts very large but finite uptime values', () => {
    mockFiles[procFile('stat')] = 'cpu  100 20 30 400 10 5 3 2\n';
    mockFiles[procFile('meminfo')] = 'MemTotal: 8000000 kB\nMemAvailable: 4000000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n';
    mockFiles[procFile('loadavg')] = '0.50 0.75 1.00 2/300 12345\n';
    mockFiles[procFile('uptime')] = '315360001 172800.00\n';

    const result = collectHost(config);
    assert.equal(result.uptimeSeconds, 315360001);
  });

  it('returns null for missing /proc files', () => {
    const result = collectHost({ hostRoot: '/nonexistent' });
    assert.equal(result.cpuPercent, null);
    assert.equal(result.memory, null);
    assert.equal(result.load, null);
    assert.equal(result.uptimeSeconds, null);
  });

  it('matches standalone collector behavior for malformed samples', () => {
    mockFiles[procFile('stat')] = 'cpu  100 20 30 400 10 5 3 2\n';
    setValidProcFiles();
    collectHost(config);
    standaloneCollectHost(config);

    mockFiles[procFile('stat')] = 'cpu  150 20 nope 450 10 5 3 2\n';
    mockFiles[procFile('meminfo')] = 'MemTotal: 8000000 kB\nSwapTotal: 0 kB\n';
    mockFiles[procFile('loadavg')] = '1.50 nope 3.25 5/400 99999\n';
    mockFiles[procFile('uptime')] = '-1 172800.00\n';

    const agentResult = collectHost(config);
    const standaloneResult = standaloneCollectHost(config);
    assert.deepEqual(standaloneResult, agentResult);
  });
});
