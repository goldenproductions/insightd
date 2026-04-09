import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs = require('fs');
import path = require('path');
import os = require('os');

function loadCollector(): { collectDiskIO: (config: any) => any } {
  delete require.cache[require.resolve('../../agent/src/collectors/disk-io')];
  return require('../../agent/src/collectors/disk-io');
}

// /proc/diskstats fields (kernel docs):
//  1 major  2 minor  3 device  4 reads  5 reads_merged  6 read_sectors  7 read_ms
//  8 writes 9 writes_merged 10 write_sectors 11 write_ms 12 in_flight 13 io_ms 14 io_weighted_ms
function diskstatsLine(device: string, readSectors: number, writeSectors: number): string {
  return `   8       0 ${device} 0 0 ${readSectors} 0 0 0 ${writeSectors} 0 0 0 0`;
}

describe('collectDiskIO', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'insightd-diskio-'));
    fs.mkdirSync(path.join(tmpRoot, 'proc'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeDiskstats(lines: string[]): void {
    fs.writeFileSync(path.join(tmpRoot, 'proc/diskstats'), lines.join('\n') + '\n');
  }

  it('returns null on first sample (baseline)', () => {
    writeDiskstats([diskstatsLine('sda', 1000, 2000)]);
    const { collectDiskIO } = loadCollector();
    assert.equal(collectDiskIO({ hostRoot: tmpRoot }), null);
  });

  it('computes bytes-per-second from sector deltas (sector = 512 bytes)', async () => {
    writeDiskstats([diskstatsLine('sda', 1000, 2000)]);
    const { collectDiskIO } = loadCollector();
    collectDiskIO({ hostRoot: tmpRoot });

    await new Promise(r => setTimeout(r, 1100));

    writeDiskstats([diskstatsLine('sda', 11000, 22000)]);
    const result = collectDiskIO({ hostRoot: tmpRoot });
    assert.ok(result);
    // 10000 read sectors * 512 / ~1.1s ≈ 4_654_545 bytes/sec
    assert.ok(result.readBytesPerSec > 4_000_000 && result.readBytesPerSec < 6_000_000, `got ${result.readBytesPerSec}`);
    assert.ok(result.writeBytesPerSec > 8_000_000 && result.writeBytesPerSec < 11_000_000, `got ${result.writeBytesPerSec}`);
  });

  it('skips loop devices, partitions, and dm- devices', async () => {
    writeDiskstats([
      diskstatsLine('loop0', 1000, 1000),
      diskstatsLine('sda1', 1000, 1000),  // partition
      diskstatsLine('dm-0', 1000, 1000),
      diskstatsLine('sda', 1000, 2000),    // real device
    ]);
    const { collectDiskIO } = loadCollector();
    collectDiskIO({ hostRoot: tmpRoot });

    await new Promise(r => setTimeout(r, 1100));

    writeDiskstats([
      diskstatsLine('loop0', 1_000_000, 1_000_000),
      diskstatsLine('sda1', 1_000_000, 1_000_000),
      diskstatsLine('dm-0', 1_000_000, 1_000_000),
      diskstatsLine('sda', 11000, 22000),
    ]);
    const result = collectDiskIO({ hostRoot: tmpRoot });
    assert.ok(result);
    // Only sda should contribute — well below the millions of sectors loop/dm/sda1 changed
    assert.ok(result.readBytesPerSec < 100_000_000, `virtual devices should be skipped, got ${result.readBytesPerSec}`);
  });

  it('aggregates across multiple real devices', async () => {
    writeDiskstats([
      diskstatsLine('sda', 1000, 2000),
      diskstatsLine('nvme0n1', 1000, 2000),
      diskstatsLine('vdb', 1000, 2000),
    ]);
    const { collectDiskIO } = loadCollector();
    collectDiskIO({ hostRoot: tmpRoot });

    await new Promise(r => setTimeout(r, 1100));

    writeDiskstats([
      diskstatsLine('sda', 2000, 3000),
      diskstatsLine('nvme0n1', 2000, 3000),
      diskstatsLine('vdb', 2000, 3000),
    ]);
    const result = collectDiskIO({ hostRoot: tmpRoot });
    assert.ok(result);
    // Each device adds 1000 sectors of read = 512000 bytes / ~1.1s ≈ 465000 per device, ×3 ≈ 1.4M
    assert.ok(result.readBytesPerSec > 1_000_000 && result.readBytesPerSec < 2_000_000);
  });

  it('returns null when /proc/diskstats is unreadable', () => {
    const { collectDiskIO } = loadCollector();
    assert.equal(collectDiskIO({ hostRoot: '/nonexistent-path' }), null);
  });

  it('clamps negative deltas to 0 (counter wrap)', async () => {
    writeDiskstats([diskstatsLine('sda', 100000, 100000)]);
    const { collectDiskIO } = loadCollector();
    collectDiskIO({ hostRoot: tmpRoot });

    await new Promise(r => setTimeout(r, 1100));

    writeDiskstats([diskstatsLine('sda', 100, 100)]);
    const result = collectDiskIO({ hostRoot: tmpRoot });
    assert.ok(result);
    assert.equal(result.readBytesPerSec, 0);
    assert.equal(result.writeBytesPerSec, 0);
  });
});
