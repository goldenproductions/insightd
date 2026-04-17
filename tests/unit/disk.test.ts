import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const fs = require('fs');
const { suppressConsole } = require('../helpers/mocks');

function loadCollectors(): { collectDisk: Function; standaloneCollectDisk: Function } {
  delete require.cache[require.resolve('../../agent/src/collectors/disk')];
  delete require.cache[require.resolve('../../src/collectors/disk')];
  return {
    collectDisk: require('../../agent/src/collectors/disk').collectDisk,
    standaloneCollectDisk: require('../../src/collectors/disk').collectDisk,
  };
}

describe('collectDisk', () => {
  let collectDisk: Function, standaloneCollectDisk: Function;
  let restore: () => void;

  beforeEach(() => {
    restore = suppressConsole();
    ({ collectDisk, standaloneCollectDisk } = loadCollectors());
  });

  afterEach(() => {
    restore();
    mock.restoreAll();
  });

  it('discovers arbitrary host mounts from host proc mounts and maps stat paths under hostRoot', () => {
    const config = { hostRoot: '/host', diskWarnPercent: 85 };
    const statfsCalls: string[] = [];

    mock.method(fs, 'existsSync', (p: string) => p === '/host');
    mock.method(fs, 'statSync', () => ({ isDirectory: () => true }));
    mock.method(fs, 'readFileSync', (p: string) => {
      assert.equal(p, path.join('/host', 'proc', 'mounts'));
      return [
        '/dev/sda1 / ext4 rw 0 0',
        '/dev/mapper/vg-data /data ext4 rw 0 0',
      ].join('\n');
    });
    mock.method(fs, 'statfsSync', (p: string) => {
      statfsCalls.push(p);
      if (p === '/host') return { bsize: 4096, blocks: 25_000_000, bavail: 12_500_000 };
      if (p === path.join('/host', 'data')) return { bsize: 4096, blocks: 50_000_000, bavail: 10_000_000 };
      throw new Error(`unexpected statfs path ${p}`);
    });

    const result = collectDisk(config);
    assert.deepEqual(
      result.map((r: any) => r.mountPoint),
      ['/', '/data']
    );
    assert.deepEqual(statfsCalls, ['/host', path.join('/host', 'data')]);
  });

  it('falls back to /proc/mounts when host root is not mounted', () => {
    const config = { hostRoot: '/host', diskWarnPercent: 85 };

    mock.method(fs, 'existsSync', () => false);
    mock.method(fs, 'readFileSync', (p: string) => {
      assert.equal(p, '/proc/mounts');
      return [
        '/dev/sda1 / ext4 rw 0 0',
        'tmpfs /tmp tmpfs rw 0 0',
      ].join('\n');
    });
    mock.method(fs, 'statfsSync', () => ({
      bsize: 4096, blocks: 25_000_000, bavail: 12_500_000,
    }));

    const result = collectDisk(config);
    assert.equal(result.length, 1);
    assert.equal(result[0].mountPoint, '/');
  });

  it('includes device-mapper-backed mounts once', () => {
    const config = { hostRoot: '/host', diskWarnPercent: 85 };

    mock.method(fs, 'existsSync', (p: string) => p === '/host');
    mock.method(fs, 'statSync', () => ({ isDirectory: () => true }));
    mock.method(fs, 'readFileSync', () => [
      '/dev/mapper/vg-data /data ext4 rw 0 0',
      '/dev/mapper/vg-data /data ext4 rw 0 0',
    ].join('\n'));
    mock.method(fs, 'statfsSync', () => ({
      bsize: 4096, blocks: 25_000_000, bavail: 12_500_000,
    }));

    const result = collectDisk(config);
    assert.equal(result.length, 1);
    assert.equal(result[0].mountPoint, '/data');
  });

  it('includes mmcblk-backed mounts', () => {
    const config = { hostRoot: '/host', diskWarnPercent: 85 };

    mock.method(fs, 'existsSync', (p: string) => p === '/host');
    mock.method(fs, 'statSync', () => ({ isDirectory: () => true }));
    mock.method(fs, 'readFileSync', () => '/dev/mmcblk0p2 / ext4 rw 0 0\n');
    mock.method(fs, 'statfsSync', () => ({
      bsize: 4096, blocks: 25_000_000, bavail: 12_500_000,
    }));

    const result = collectDisk(config);
    assert.equal(result.length, 1);
    assert.equal(result[0].mountPoint, '/');
  });

  it('excludes loop-backed mounts from disk results', () => {
    const config = { hostRoot: '/host', diskWarnPercent: 85 };

    mock.method(fs, 'existsSync', (p: string) => p === '/host');
    mock.method(fs, 'statSync', () => ({ isDirectory: () => true }));
    mock.method(fs, 'readFileSync', () => [
      '/dev/loop0 /snap/core squashfs ro 0 0',
      '/dev/sda1 / ext4 rw 0 0',
    ].join('\n'));
    mock.method(fs, 'statfsSync', () => ({
      bsize: 4096, blocks: 25_000_000, bavail: 12_500_000,
    }));

    const result = collectDisk(config);
    assert.equal(result.length, 1);
    assert.equal(result[0].mountPoint, '/');
  });

  it('calculates GB correctly', () => {
    const config = { hostRoot: '/host', diskWarnPercent: 85 };

    mock.method(fs, 'existsSync', (p: string) => p === '/host');
    mock.method(fs, 'statSync', () => ({ isDirectory: () => true }));
    mock.method(fs, 'readFileSync', () => '/dev/sda1 / ext4 rw 0 0\n');
    mock.method(fs, 'statfsSync', () => ({
      bsize: 4096, blocks: 24_414_062, bavail: 2_441_406,
    }));

    const result = collectDisk(config);
    assert.ok(result[0].totalGb > 99 && result[0].totalGb < 101);
    assert.ok(result[0].usedPercent > 89 && result[0].usedPercent < 91);
  });

  it('handles per-mount statfs failure gracefully', () => {
    const config = { hostRoot: '/host', diskWarnPercent: 85 };

    mock.method(fs, 'existsSync', (p: string) => p === '/host');
    mock.method(fs, 'statSync', () => ({ isDirectory: () => true }));
    mock.method(fs, 'readFileSync', () => [
      '/dev/sda1 / ext4 rw 0 0',
      '/dev/mapper/vg-data /data ext4 rw 0 0',
    ].join('\n'));
    mock.method(fs, 'statfsSync', (p: string) => {
      if (p === '/host') return { bsize: 4096, blocks: 25_000_000, bavail: 12_500_000 };
      throw new Error('ENOENT');
    });

    const result = collectDisk(config);
    assert.equal(result.length, 1);
    assert.equal(result[0].mountPoint, '/');
  });

  it('matches standalone collector behavior for host mount discovery', () => {
    const config = { hostRoot: '/host', diskWarnPercent: 85 };

    mock.method(fs, 'existsSync', (p: string) => p === '/host');
    mock.method(fs, 'statSync', () => ({ isDirectory: () => true }));
    mock.method(fs, 'readFileSync', () => [
      '/dev/sda1 / ext4 rw 0 0',
      '/dev/mapper/vg-data /data ext4 rw 0 0',
    ].join('\n'));
    mock.method(fs, 'statfsSync', (p: string) => {
      if (p === '/host') return { bsize: 4096, blocks: 25_000_000, bavail: 12_500_000 };
      if (p === path.join('/host', 'data')) return { bsize: 4096, blocks: 50_000_000, bavail: 10_000_000 };
      throw new Error(`unexpected statfs path ${p}`);
    });

    const agentResult = collectDisk(config);
    const standaloneResult = standaloneCollectDisk(config);
    assert.deepEqual(standaloneResult, agentResult);
  });

  it('matches standalone collector behavior for mmcblk and loop filtering', () => {
    const config = { hostRoot: '/host', diskWarnPercent: 85 };

    mock.method(fs, 'existsSync', (p: string) => p === '/host');
    mock.method(fs, 'statSync', () => ({ isDirectory: () => true }));
    mock.method(fs, 'readFileSync', () => [
      '/dev/mmcblk0p2 / ext4 rw 0 0',
      '/dev/loop0 /snap/core squashfs ro 0 0',
    ].join('\n'));
    mock.method(fs, 'statfsSync', () => ({
      bsize: 4096, blocks: 25_000_000, bavail: 12_500_000,
    }));

    const agentResult = collectDisk(config);
    const standaloneResult = standaloneCollectDisk(config);
    assert.deepEqual(standaloneResult, agentResult);
  });
});
