import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs = require('fs');
import path = require('path');
import os = require('os');

function loadCollector(): { collectNetworkIO: (config: any) => any } {
  delete require.cache[require.resolve('../../agent/src/collectors/network-io')];
  return require('../../agent/src/collectors/network-io');
}

function makeProcNetDev(rows: Array<{ iface: string; rx: number; tx: number }>): string {
  // /proc/net/dev format: header (2 lines), then per-interface stats
  const header = [
    'Inter-|   Receive                                                |  Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
  ];
  const body = rows.map(r =>
    // 16 columns total: iface: rx_bytes packets errs drop fifo frame compr mcast tx_bytes packets errs drop fifo colls carrier compr
    `${r.iface.padStart(8, ' ')}: ${r.rx} 0 0 0 0 0 0 0 ${r.tx} 0 0 0 0 0 0 0`
  );
  return [...header, ...body].join('\n') + '\n';
}

describe('collectNetworkIO', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'insightd-netio-'));
    fs.mkdirSync(path.join(tmpRoot, 'proc/net'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeStats(rows: Array<{ iface: string; rx: number; tx: number }>): void {
    fs.writeFileSync(path.join(tmpRoot, 'proc/net/dev'), makeProcNetDev(rows));
  }

  it('returns null on the first sample (no baseline yet)', () => {
    writeStats([{ iface: 'eth0', rx: 1000, tx: 2000 }]);
    const { collectNetworkIO } = loadCollector();
    assert.equal(collectNetworkIO({ hostRoot: tmpRoot }), null);
  });

  it('computes per-second rates from delta between two samples', async () => {
    writeStats([{ iface: 'eth0', rx: 1000, tx: 2000 }]);
    const { collectNetworkIO } = loadCollector();
    collectNetworkIO({ hostRoot: tmpRoot }); // baseline

    // Wait > 1 second so the elapsed-time guard passes
    await new Promise(r => setTimeout(r, 1100));

    writeStats([{ iface: 'eth0', rx: 11000, tx: 22000 }]);
    const result = collectNetworkIO({ hostRoot: tmpRoot });
    assert.ok(result);
    // Delta: 10000 rx, 20000 tx, over ~1.1s → ~9090 rx, ~18181 tx (rounded)
    assert.ok(result.rxBytesPerSec > 8000 && result.rxBytesPerSec < 11000, `rxBytesPerSec ~9000, got ${result.rxBytesPerSec}`);
    assert.ok(result.txBytesPerSec > 16000 && result.txBytesPerSec < 22000, `txBytesPerSec ~18000, got ${result.txBytesPerSec}`);
  });

  it('skips loopback, docker, veth, and other virtual interfaces', async () => {
    writeStats([
      { iface: 'lo', rx: 1000, tx: 1000 },
      { iface: 'docker0', rx: 1000, tx: 1000 },
      { iface: 'veth1234', rx: 1000, tx: 1000 },
      { iface: 'br-abc', rx: 1000, tx: 1000 },
      { iface: 'eth0', rx: 1000, tx: 2000 },
    ]);
    const { collectNetworkIO } = loadCollector();
    collectNetworkIO({ hostRoot: tmpRoot });

    await new Promise(r => setTimeout(r, 1100));

    // Update virtual ifaces dramatically — they should NOT contribute
    writeStats([
      { iface: 'lo', rx: 1000000, tx: 1000000 },
      { iface: 'docker0', rx: 1000000, tx: 1000000 },
      { iface: 'veth1234', rx: 1000000, tx: 1000000 },
      { iface: 'br-abc', rx: 1000000, tx: 1000000 },
      { iface: 'eth0', rx: 11000, tx: 22000 },
    ]);
    const result = collectNetworkIO({ hostRoot: tmpRoot });
    assert.ok(result);
    // Only eth0 contributes (~10000 rx delta over ~1.1s ≈ 9000)
    assert.ok(result.rxBytesPerSec < 50000, `should not include virtual interfaces; got ${result.rxBytesPerSec}`);
  });

  it('returns null when /proc/net/dev is unreadable', () => {
    const { collectNetworkIO } = loadCollector();
    assert.equal(collectNetworkIO({ hostRoot: '/nonexistent-path' }), null);
  });

  it('returns null when no real interfaces are present', () => {
    writeStats([{ iface: 'lo', rx: 100, tx: 100 }]);
    const { collectNetworkIO } = loadCollector();
    assert.equal(collectNetworkIO({ hostRoot: tmpRoot }), null);
  });

  it('clamps negative deltas to 0 (handles counter resets/wraps)', async () => {
    writeStats([{ iface: 'eth0', rx: 100000, tx: 200000 }]);
    const { collectNetworkIO } = loadCollector();
    collectNetworkIO({ hostRoot: tmpRoot });

    await new Promise(r => setTimeout(r, 1100));

    // Counter went down (reset)
    writeStats([{ iface: 'eth0', rx: 5000, tx: 10000 }]);
    const result = collectNetworkIO({ hostRoot: tmpRoot });
    assert.ok(result);
    assert.equal(result.rxBytesPerSec, 0);
    assert.equal(result.txBytesPerSec, 0);
  });
});
