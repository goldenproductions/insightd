const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { createTestDb } = require('../helpers/db');
const { suppressConsole } = require('../helpers/mocks');

describe('collectDisk', () => {
  let db;
  let collectDisk;
  let restore;

  beforeEach(() => {
    restore = suppressConsole();
    db = createTestDb();
    delete require.cache[require.resolve('../../src/collectors/disk')];
    collectDisk = require('../../src/collectors/disk').collectDisk;
  });

  afterEach(() => {
    db.close();
    restore();
    mock.restoreAll();
  });

  it('stats host root when /host exists', () => {
    mock.method(fs, 'existsSync', (p) => p === '/host');
    mock.method(fs, 'statSync', () => ({ isDirectory: () => true }));
    mock.method(fs, 'statfsSync', () => ({
      bsize: 4096, blocks: 25000000, bavail: 12500000, type: 0xEF53,
    }));

    const config = { hostRoot: '/host', diskWarnPercent: 85 };
    const result = collectDisk(db, config);

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
    const result = collectDisk(db, config);

    assert.equal(result.length, 1);
    assert.equal(result[0].mountPoint, '/');
  });

  it('calculates GB correctly', () => {
    mock.method(fs, 'existsSync', (p) => p === '/host');
    mock.method(fs, 'statSync', () => ({ isDirectory: () => true }));
    mock.method(fs, 'statfsSync', () => ({
      bsize: 4096, blocks: 24414062, bavail: 2441406, type: 0xEF53,
    }));

    const config = { hostRoot: '/host', diskWarnPercent: 85 };
    const result = collectDisk(db, config);

    assert.ok(result[0].totalGb > 99 && result[0].totalGb < 101);
    assert.ok(result[0].usedPercent > 89 && result[0].usedPercent < 91);
  });

  it('stores results in disk_snapshots', () => {
    mock.method(fs, 'existsSync', (p) => p === '/host');
    mock.method(fs, 'statSync', () => ({ isDirectory: () => true }));
    mock.method(fs, 'statfsSync', () => ({
      bsize: 4096, blocks: 25000000, bavail: 12500000, type: 0xEF53,
    }));

    const config = { hostRoot: '/host', diskWarnPercent: 85 };
    collectDisk(db, config);

    const rows = db.prepare('SELECT * FROM disk_snapshots').all();
    assert.equal(rows.length, 1);
  });

  it('handles statfs failure gracefully', () => {
    mock.method(fs, 'existsSync', (p) => p === '/host');
    mock.method(fs, 'statSync', () => ({ isDirectory: () => true }));
    mock.method(fs, 'statfsSync', () => { throw new Error('ENOENT'); });

    const config = { hostRoot: '/host', diskWarnPercent: 85 };
    const result = collectDisk(db, config);
    assert.equal(result.length, 0);
  });
});
