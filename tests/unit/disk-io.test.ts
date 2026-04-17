import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs = require('fs');
import path = require('path');
import os = require('os');

function loadCollectors(): {
  collectDiskIO: (config: any) => any;
  standaloneCollectDiskIO: (config: any) => any;
} {
  delete require.cache[require.resolve('../../agent/src/collectors/disk-io')];
  delete require.cache[require.resolve('../../src/collectors/disk-io')];
  return {
    collectDiskIO: require('../../agent/src/collectors/disk-io').collectDiskIO,
    standaloneCollectDiskIO: require('../../src/collectors/disk-io').collectDiskIO,
  };
}

function diskstatsLine(device: string, readSectors: number | string, writeSectors: number | string): string {
  return `   8       0 ${device} 0 0 ${readSectors} 0 0 0 ${writeSectors} 0 0 0 0`;
}

describe('collectDiskIO', () => {
  let tmpRoot: string;
  let tmpRoot2: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'insightd-diskio-'));
    tmpRoot2 = fs.mkdtempSync(path.join(os.tmpdir(), 'insightd-diskio-'));
    fs.mkdirSync(path.join(tmpRoot, 'proc'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot2, 'proc'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(tmpRoot2, { recursive: true, force: true });
  });

  function writeDiskstats(root: string, lines: string[]): void {
    fs.writeFileSync(path.join(root, 'proc', 'diskstats'), lines.join('\n') + '\n');
  }

  function writeBlockSlaves(root: string, device: string, slaves: string[]): void {
    const slaveDir = path.join(root, 'sys', 'block', device, 'slaves');
    fs.mkdirSync(slaveDir, { recursive: true });
    for (const slave of slaves) {
      fs.mkdirSync(path.join(slaveDir, slave), { recursive: true });
    }
  }

  it('returns null on first sample (baseline)', () => {
    writeDiskstats(tmpRoot, [diskstatsLine('sda', 1000, 2000)]);
    const { collectDiskIO } = loadCollectors();
    assert.equal(collectDiskIO({ hostRoot: tmpRoot }), null);
  });

  it('computes bytes-per-second from sector deltas', async () => {
    writeDiskstats(tmpRoot, [diskstatsLine('sda', 1000, 2000)]);
    const { collectDiskIO } = loadCollectors();
    collectDiskIO({ hostRoot: tmpRoot });

    await new Promise(r => setTimeout(r, 1100));

    writeDiskstats(tmpRoot, [diskstatsLine('sda', 11000, 22000)]);
    const result = collectDiskIO({ hostRoot: tmpRoot });
    assert.ok(result);
    assert.ok(result.readBytesPerSec > 4_000_000 && result.readBytesPerSec < 6_000_000, `got ${result.readBytesPerSec}`);
    assert.ok(result.writeBytesPerSec > 8_000_000 && result.writeBytesPerSec < 11_000_000, `got ${result.writeBytesPerSec}`);
  });

  it('skips loop devices and partitions', async () => {
    writeDiskstats(tmpRoot, [
      diskstatsLine('loop0', 1000, 1000),
      diskstatsLine('sda1', 1000, 1000),
      diskstatsLine('sda', 1000, 2000),
    ]);
    const { collectDiskIO } = loadCollectors();
    collectDiskIO({ hostRoot: tmpRoot });

    await new Promise(r => setTimeout(r, 1100));

    writeDiskstats(tmpRoot, [
      diskstatsLine('loop0', 1_000_000, 1_000_000),
      diskstatsLine('sda1', 1_000_000, 1_000_000),
      diskstatsLine('sda', 11_000, 22_000),
    ]);
    const result = collectDiskIO({ hostRoot: tmpRoot });
    assert.ok(result);
    assert.ok(result.readBytesPerSec < 100_000_000, `virtual devices should be skipped, got ${result.readBytesPerSec}`);
  });

  it('aggregates across multiple real devices', async () => {
    writeDiskstats(tmpRoot, [
      diskstatsLine('sda', 1000, 2000),
      diskstatsLine('nvme0n1', 1000, 2000),
      diskstatsLine('vdb', 1000, 2000),
    ]);
    const { collectDiskIO } = loadCollectors();
    collectDiskIO({ hostRoot: tmpRoot });

    await new Promise(r => setTimeout(r, 1100));

    writeDiskstats(tmpRoot, [
      diskstatsLine('sda', 2000, 3000),
      diskstatsLine('nvme0n1', 2000, 3000),
      diskstatsLine('vdb', 2000, 3000),
    ]);
    const result = collectDiskIO({ hostRoot: tmpRoot });
    assert.ok(result);
    assert.ok(result.readBytesPerSec > 1_000_000 && result.readBytesPerSec < 2_000_000);
  });

  it('counts dm- devices and excludes their slave raw disks', async () => {
    writeBlockSlaves(tmpRoot, 'dm-0', ['sda']);
    writeDiskstats(tmpRoot, [
      diskstatsLine('sda', 1000, 2000),
      diskstatsLine('dm-0', 1000, 2000),
    ]);
    const { collectDiskIO } = loadCollectors();
    collectDiskIO({ hostRoot: tmpRoot });

    await new Promise(r => setTimeout(r, 1100));

    writeDiskstats(tmpRoot, [
      diskstatsLine('sda', 1_000_000, 1_000_000),
      diskstatsLine('dm-0', 2000, 3000),
    ]);
    const result = collectDiskIO({ hostRoot: tmpRoot });
    assert.ok(result);
    assert.ok(result.readBytesPerSec > 300_000 && result.readBytesPerSec < 700_000, `expected dm-only read rate, got ${result.readBytesPerSec}`);
    assert.ok(result.writeBytesPerSec > 300_000 && result.writeBytesPerSec < 700_000, `expected dm-only write rate, got ${result.writeBytesPerSec}`);
  });

  it('tracks mmcblk devices as real disks', async () => {
    writeDiskstats(tmpRoot, [diskstatsLine('mmcblk0', 1000, 2000)]);
    const { collectDiskIO } = loadCollectors();
    collectDiskIO({ hostRoot: tmpRoot });

    await new Promise(r => setTimeout(r, 1100));

    writeDiskstats(tmpRoot, [diskstatsLine('mmcblk0', 2000, 3000)]);
    const result = collectDiskIO({ hostRoot: tmpRoot });
    assert.ok(result);
    assert.ok(result.readBytesPerSec > 300_000 && result.readBytesPerSec < 700_000, `expected mmc read rate, got ${result.readBytesPerSec}`);
    assert.ok(result.writeBytesPerSec > 300_000 && result.writeBytesPerSec < 700_000, `expected mmc write rate, got ${result.writeBytesPerSec}`);
  });

  it('counts md devices and excludes their member disks', async () => {
    writeBlockSlaves(tmpRoot, 'md0', ['sda', 'sdb']);
    writeDiskstats(tmpRoot, [
      diskstatsLine('sda', 1000, 2000),
      diskstatsLine('sdb', 1000, 2000),
      diskstatsLine('md0', 1000, 2000),
    ]);
    const { collectDiskIO } = loadCollectors();
    collectDiskIO({ hostRoot: tmpRoot });

    await new Promise(r => setTimeout(r, 1100));

    writeDiskstats(tmpRoot, [
      diskstatsLine('sda', 50_000, 60_000),
      diskstatsLine('sdb', 50_000, 60_000),
      diskstatsLine('md0', 2000, 3000),
    ]);
    const result = collectDiskIO({ hostRoot: tmpRoot });
    assert.ok(result);
    assert.ok(result.readBytesPerSec > 300_000 && result.readBytesPerSec < 700_000, `expected md-only read rate, got ${result.readBytesPerSec}`);
    assert.ok(result.writeBytesPerSec > 300_000 && result.writeBytesPerSec < 700_000, `expected md-only write rate, got ${result.writeBytesPerSec}`);
  });

  it('returns null when /proc/diskstats is unreadable', () => {
    const { collectDiskIO } = loadCollectors();
    assert.equal(collectDiskIO({ hostRoot: '/nonexistent-path' }), null);
  });

  it('clamps negative deltas to 0 (counter wrap)', async () => {
    writeDiskstats(tmpRoot, [diskstatsLine('sda', 100000, 100000)]);
    const { collectDiskIO } = loadCollectors();
    collectDiskIO({ hostRoot: tmpRoot });

    await new Promise(r => setTimeout(r, 1100));

    writeDiskstats(tmpRoot, [diskstatsLine('sda', 100, 100)]);
    const result = collectDiskIO({ hostRoot: tmpRoot });
    assert.ok(result);
    assert.equal(result.readBytesPerSec, 0);
    assert.equal(result.writeBytesPerSec, 0);
  });

  it('skips malformed sector fields without poisoning the next valid sample', async () => {
    writeDiskstats(tmpRoot, [diskstatsLine('sda', 1000, 2000)]);
    const { collectDiskIO } = loadCollectors();
    collectDiskIO({ hostRoot: tmpRoot });

    await new Promise(r => setTimeout(r, 1100));

    writeDiskstats(tmpRoot, [diskstatsLine('sda', 'not-a-number', 3000)]);
    assert.equal(collectDiskIO({ hostRoot: tmpRoot }), null);

    await new Promise(r => setTimeout(r, 1100));

    writeDiskstats(tmpRoot, [diskstatsLine('sda', 2000, 3000)]);
    const result = collectDiskIO({ hostRoot: tmpRoot });
    assert.ok(result);
    assert.ok(result.readBytesPerSec > 200_000 && result.readBytesPerSec < 300_000, `expected baseline-preserving read rate, got ${result.readBytesPerSec}`);
    assert.ok(result.writeBytesPerSec > 200_000 && result.writeBytesPerSec < 300_000, `expected baseline-preserving write rate, got ${result.writeBytesPerSec}`);
  });

  it('keeps baseline state isolated per hostRoot', async () => {
    writeDiskstats(tmpRoot, [diskstatsLine('sda', 1000, 2000)]);
    writeDiskstats(tmpRoot2, [diskstatsLine('sda', 5000, 7000)]);
    const { collectDiskIO } = loadCollectors();
    collectDiskIO({ hostRoot: tmpRoot });
    collectDiskIO({ hostRoot: tmpRoot2 });

    await new Promise(r => setTimeout(r, 1100));

    writeDiskstats(tmpRoot, [diskstatsLine('sda', 2000, 3000)]);
    writeDiskstats(tmpRoot2, [diskstatsLine('sda', 5500, 7600)]);
    const result1 = collectDiskIO({ hostRoot: tmpRoot });
    const result2 = collectDiskIO({ hostRoot: tmpRoot2 });

    assert.ok(result1);
    assert.ok(result2);
    assert.ok(result1.readBytesPerSec > 300_000 && result1.readBytesPerSec < 700_000, `root1 read rate incorrect: ${result1.readBytesPerSec}`);
    assert.ok(result2.readBytesPerSec > 200_000 && result2.readBytesPerSec < 300_000, `root2 read rate incorrect: ${result2.readBytesPerSec}`);
  });

  it('matches standalone collector behavior for dm and malformed samples', async () => {
    writeBlockSlaves(tmpRoot, 'dm-0', ['sda']);
    writeDiskstats(tmpRoot, [
      diskstatsLine('sda', 1000, 2000),
      diskstatsLine('dm-0', 1000, 2000),
    ]);
    const { collectDiskIO, standaloneCollectDiskIO } = loadCollectors();
    collectDiskIO({ hostRoot: tmpRoot });
    standaloneCollectDiskIO({ hostRoot: tmpRoot });

    await new Promise(r => setTimeout(r, 1100));

    writeDiskstats(tmpRoot, [
      diskstatsLine('sda', 'bad', 3000),
      diskstatsLine('dm-0', 2000, 3000),
    ]);
    const agentResult = collectDiskIO({ hostRoot: tmpRoot });
    const standaloneResult = standaloneCollectDiskIO({ hostRoot: tmpRoot });
    assert.ok(agentResult);
    assert.ok(standaloneResult);
    assert.ok(Math.abs(standaloneResult.readBytesPerSec - agentResult.readBytesPerSec) < 10_000);
    assert.ok(Math.abs(standaloneResult.writeBytesPerSec - agentResult.writeBytesPerSec) < 10_000);
  });

  it('matches standalone collector behavior for mmcblk and md devices', async () => {
    writeBlockSlaves(tmpRoot, 'md0', ['sda']);
    writeDiskstats(tmpRoot, [
      diskstatsLine('sda', 1000, 2000),
      diskstatsLine('md0', 1000, 2000),
      diskstatsLine('mmcblk0', 1000, 2000),
    ]);
    const { collectDiskIO, standaloneCollectDiskIO } = loadCollectors();
    collectDiskIO({ hostRoot: tmpRoot });
    standaloneCollectDiskIO({ hostRoot: tmpRoot });

    await new Promise(r => setTimeout(r, 1100));

    writeDiskstats(tmpRoot, [
      diskstatsLine('sda', 100_000, 100_000),
      diskstatsLine('md0', 2000, 3000),
      diskstatsLine('mmcblk0', 2000, 3000),
    ]);

    const agentResult = collectDiskIO({ hostRoot: tmpRoot });
    const standaloneResult = standaloneCollectDiskIO({ hostRoot: tmpRoot });

    assert.ok(agentResult);
    assert.ok(standaloneResult);
    assert.ok(Math.abs(agentResult.readBytesPerSec - standaloneResult.readBytesPerSec) < 10_000);
    assert.ok(Math.abs(agentResult.writeBytesPerSec - standaloneResult.writeBytesPerSec) < 10_000);
  });

  it('keeps slave raw disks excluded when the dm row is malformed', async () => {
    writeBlockSlaves(tmpRoot, 'dm-0', ['sda']);
    writeDiskstats(tmpRoot, [
      diskstatsLine('sda', 1000, 2000),
      diskstatsLine('dm-0', 1000, 2000),
    ]);
    const { collectDiskIO, standaloneCollectDiskIO } = loadCollectors();
    collectDiskIO({ hostRoot: tmpRoot });
    standaloneCollectDiskIO({ hostRoot: tmpRoot });

    await new Promise(r => setTimeout(r, 1100));

    writeDiskstats(tmpRoot, [
      diskstatsLine('sda', 10_000, 20_000),
      diskstatsLine('dm-0', 'bad', 3000),
    ]);

    const agentResult = collectDiskIO({ hostRoot: tmpRoot });
    const standaloneResult = standaloneCollectDiskIO({ hostRoot: tmpRoot });

    assert.ok(agentResult);
    assert.ok(standaloneResult);
    assert.equal(agentResult.readBytesPerSec, 0);
    assert.equal(agentResult.writeBytesPerSec, 0);
    assert.equal(standaloneResult.readBytesPerSec, 0);
    assert.equal(standaloneResult.writeBytesPerSec, 0);
  });
});
