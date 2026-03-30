const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

// Mock fs.readFileSync before requiring the module
const originalReadFileSync = fs.readFileSync;

describe('collectHost', () => {
  let collectHost, _resetPrevCpu;
  let mockFiles = {};

  beforeEach(() => {
    mockFiles = {};
    mock.method(fs, 'readFileSync', (filePath, encoding) => {
      const p = filePath.toString();
      if (mockFiles[p] !== undefined) return mockFiles[p];
      return originalReadFileSync(filePath, encoding);
    });

    // Fresh require
    delete require.cache[require.resolve('../../agent/src/collectors/host')];
    const mod = require('../../agent/src/collectors/host');
    collectHost = mod.collectHost;
    _resetPrevCpu = mod._resetPrevCpu;
    _resetPrevCpu();
  });

  afterEach(() => {
    mock.restoreAll();
    _resetPrevCpu();
  });

  const config = { hostRoot: '/host' };

  it('returns null CPU on first call (needs two readings for delta)', () => {
    mockFiles['/host/proc/stat'] = 'cpu  100 20 30 400 10 5 3 2\n';
    mockFiles['/host/proc/meminfo'] = 'MemTotal:       8000000 kB\nMemAvailable:   4000000 kB\nSwapTotal:      2000000 kB\nSwapFree:       1500000 kB\n';
    mockFiles['/host/proc/loadavg'] = '0.50 0.75 1.00 2/300 12345\n';
    mockFiles['/host/proc/uptime'] = '86400.50 172800.00\n';

    const result = collectHost(config);
    assert.equal(result.cpuPercent, null);
  });

  it('calculates CPU percent from delta on second call', () => {
    // First reading: total=570, active=160
    mockFiles['/host/proc/stat'] = 'cpu  100 20 30 400 10 5 3 2\n';
    mockFiles['/host/proc/meminfo'] = 'MemTotal: 8000000 kB\nMemAvailable: 4000000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n';
    mockFiles['/host/proc/loadavg'] = '0.50 0.75 1.00 2/300 12345\n';
    mockFiles['/host/proc/uptime'] = '86400.50 172800.00\n';
    collectHost(config);

    // Second reading: total=670, active=210 → delta: active=50, total=100 → 50%
    mockFiles['/host/proc/stat'] = 'cpu  150 20 30 450 10 5 3 2\n';
    const result = collectHost(config);
    assert.equal(result.cpuPercent, 50);
  });

  it('parses memory info correctly', () => {
    mockFiles['/host/proc/stat'] = 'cpu  100 20 30 400 10 5 3 2\n';
    mockFiles['/host/proc/meminfo'] = 'MemTotal:       16384000 kB\nMemAvailable:    8192000 kB\nSwapTotal:       4096000 kB\nSwapFree:        2048000 kB\n';
    mockFiles['/host/proc/loadavg'] = '1.00 2.00 3.00 2/300 12345\n';
    mockFiles['/host/proc/uptime'] = '3600.00 7200.00\n';

    const result = collectHost(config);
    assert.equal(result.memory.totalMb, 16000);
    assert.equal(result.memory.usedMb, 8000);
    assert.equal(result.memory.availableMb, 8000);
    assert.equal(result.memory.swapTotalMb, 4000);
    assert.equal(result.memory.swapUsedMb, 2000);
  });

  it('parses load average', () => {
    mockFiles['/host/proc/stat'] = 'cpu  100 20 30 400 10 5 3 2\n';
    mockFiles['/host/proc/meminfo'] = 'MemTotal: 8000000 kB\nMemAvailable: 4000000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n';
    mockFiles['/host/proc/loadavg'] = '1.50 2.75 3.25 5/400 99999\n';
    mockFiles['/host/proc/uptime'] = '86400.50 172800.00\n';

    const result = collectHost(config);
    assert.equal(result.load.load1, 1.5);
    assert.equal(result.load.load5, 2.75);
    assert.equal(result.load.load15, 3.25);
  });

  it('parses uptime', () => {
    mockFiles['/host/proc/stat'] = 'cpu  100 20 30 400 10 5 3 2\n';
    mockFiles['/host/proc/meminfo'] = 'MemTotal: 8000000 kB\nMemAvailable: 4000000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n';
    mockFiles['/host/proc/loadavg'] = '0.50 0.75 1.00 2/300 12345\n';
    mockFiles['/host/proc/uptime'] = '86400.50 172800.00\n';

    const result = collectHost(config);
    assert.equal(result.uptimeSeconds, 86400.5);
  });

  it('returns null for missing /proc files', () => {
    // Point to a non-existent path so all reads fail
    const result = collectHost({ hostRoot: '/nonexistent' });
    assert.equal(result.cpuPercent, null);
    assert.equal(result.memory, null);
    assert.equal(result.load, null);
    assert.equal(result.uptimeSeconds, null);
  });
});
