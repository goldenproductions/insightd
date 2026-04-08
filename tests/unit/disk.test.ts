import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
const fs = require('fs');
const { suppressConsole } = require('../helpers/mocks');

describe('collectDisk', () => {
  let collectDisk: Function;
  let restore: () => void;

  beforeEach(() => {
    restore = suppressConsole();
    delete require.cache[require.resolve('../../src/collectors/disk')];
    collectDisk = require('../../src/collectors/disk').collectDisk;
  });

  afterEach(() => {
    restore();
    mock.restoreAll();
  });

  it('stats host root when /host exists', () => {
    mock.method(fs, 'existsSync', (p: string) => p === '/host');
    mock.method(fs, 'statSync', () => ({ isDirectory: () => true }));
    mock.method(fs, 'statfsSync', () => ({
      bsize: 4096, blocks: 25000000, bavail: 12500000, type: 0xEF53,
    }));

    const config = { hostRoot: '/host', diskWarnPercent: 85 };
    const result = collectDisk(config);

    assert.equal(result.length, 1);
    assert.equal(result[0].mountPoint, '/');
    assert.ok(result[0].totalGb > 0);
    assert.ok(result[0].usedGb > 0);
  });

  it('falls back to /proc/mounts when host not mounted', () => {
    mock.method(fs, 'existsSync', () => false);
    mock.method(fs, 'readFileSync', () =>
      '/dev/sda1 / ext4 rw,relatime 0 0\ntmpfs /tmp tmpfs rw 0 0\n'
    );
    mock.method(fs, 'statfsSync', () => ({
      bsize: 4096, blocks: 25000000, bavail: 12500000, type: 0xEF53,
    }));

    const config = { hostRoot: '/host', diskWarnPercent: 85 };
    const result = collectDisk(config);

    assert.equal(result.length, 1);
    assert.equal(result[0].mountPoint, '/');
  });

  it('calculates GB correctly', () => {
    mock.method(fs, 'existsSync', (p: string) => p === '/host');
    mock.method(fs, 'statSync', () => ({ isDirectory: () => true }));
    mock.method(fs, 'statfsSync', () => ({
      bsize: 4096, blocks: 24414062, bavail: 2441406, type: 0xEF53,
    }));

    const config = { hostRoot: '/host', diskWarnPercent: 85 };
    const result = collectDisk(config);

    assert.ok(result[0].totalGb > 99 && result[0].totalGb < 101);
    assert.ok(result[0].usedPercent > 89 && result[0].usedPercent < 91);
  });

  it('returns data without DB dependency', () => {
    mock.method(fs, 'existsSync', (p: string) => p === '/host');
    mock.method(fs, 'statSync', () => ({ isDirectory: () => true }));
    mock.method(fs, 'statfsSync', () => ({
      bsize: 4096, blocks: 25000000, bavail: 12500000, type: 0xEF53,
    }));

    const config = { hostRoot: '/host', diskWarnPercent: 85 };
    const result = collectDisk(config);

    assert.ok(Array.isArray(result));
    assert.ok(result[0].mountPoint);
    assert.ok(typeof result[0].totalGb === 'number');
  });

  it('handles statfs failure gracefully', () => {
    mock.method(fs, 'existsSync', (p: string) => p === '/host');
    mock.method(fs, 'statSync', () => ({ isDirectory: () => true }));
    mock.method(fs, 'statfsSync', () => { throw new Error('ENOENT'); });

    const config = { hostRoot: '/host', diskWarnPercent: 85 };
    const result = collectDisk(config);
    assert.equal(result.length, 0);
  });
});
