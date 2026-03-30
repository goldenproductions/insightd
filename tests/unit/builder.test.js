const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb, seedContainerSnapshots, seedDiskSnapshots, seedUpdateChecks } = require('../helpers/db');
const { ts, NOW, THIS_WEEK, LAST_WEEK } = require('../helpers/fixtures');
const { suppressConsole } = require('../helpers/mocks');

describe('buildDigest', () => {
  let db;
  let buildDigest;
  let config;
  let restore;

  beforeEach(() => {
    restore = suppressConsole();
    db = createTestDb();
    delete require.cache[require.resolve('../../src/digest/builder')];
    buildDigest = require('../../src/digest/builder').buildDigest;
    config = { diskWarnPercent: 85 };
  });

  afterEach(() => {
    db.close();
    restore();
  });

  it('empty database produces green digest', () => {
    const digest = buildDigest(db, config);
    assert.equal(digest.overallStatus, 'green');
    assert.equal(digest.summaryLine, 'No critical issues. Good week.');
    assert.equal(digest.totalRestarts, 0);
    assert.equal(digest.containers.length, 0);
  });

  it('all running containers produce 100% uptime', () => {
    const snapshots = [];
    for (let i = 0; i < 5; i++) {
      const t = new Date(NOW - i * 5 * 60 * 1000); // every 5 min
      snapshots.push({ name: 'nginx', status: 'running', at: ts(t) });
    }
    seedContainerSnapshots(db, snapshots);

    const digest = buildDigest(db, config);
    assert.equal(digest.containers[0].uptimePercent, 100);
    assert.equal(digest.containers[0].status, 'green');
  });

  it('calculates correct uptime percentage with downtime', () => {
    const snapshots = [];
    for (let i = 0; i < 10; i++) {
      const t = new Date(NOW - i * 5 * 60 * 1000);
      snapshots.push({
        name: 'nginx',
        status: i < 8 ? 'running' : 'exited', // 8 running, 2 stopped = 80%
        at: ts(t),
      });
    }
    seedContainerSnapshots(db, snapshots);

    const digest = buildDigest(db, config);
    assert.equal(digest.containers[0].uptimePercent, 80);
    assert.equal(digest.containers[0].status, 'red'); // <90% = red
  });

  it('counts restarts correctly', () => {
    seedContainerSnapshots(db, [
      { name: 'nginx', restarts: 2, at: ts(new Date(NOW - 60000)) },
      { name: 'nginx', restarts: 5, at: ts(NOW) },
    ]);

    const digest = buildDigest(db, config);
    assert.equal(digest.containers[0].restarts, 3); // 5 - 2
    assert.equal(digest.totalRestarts, 3);
    assert.deepEqual(digest.restartedContainers, ['nginx']);
  });

  it('flags resource trends over 10%', () => {
    // Last week data
    for (let i = 0; i < 5; i++) {
      const t = new Date(LAST_WEEK.getTime() + i * 5 * 60 * 1000);
      seedContainerSnapshots(db, [
        { name: 'postgres', cpu: 10, mem: 100, at: ts(t) },
      ]);
    }
    // This week data — 25% more RAM
    for (let i = 0; i < 5; i++) {
      const t = new Date(THIS_WEEK.getTime() + i * 5 * 60 * 1000);
      seedContainerSnapshots(db, [
        { name: 'postgres', cpu: 10, mem: 125, at: ts(t) },
      ]);
    }

    const digest = buildDigest(db, config);
    assert.ok(digest.trends.length > 0);
    const postgresTrend = digest.trends.find(t => t.name === 'postgres');
    assert.ok(postgresTrend);
    assert.ok(postgresTrend.flagged);
    assert.equal(postgresTrend.ramChange, 25);
  });

  it('does not flag trends under 10%', () => {
    for (let i = 0; i < 5; i++) {
      const t = new Date(LAST_WEEK.getTime() + i * 5 * 60 * 1000);
      seedContainerSnapshots(db, [{ name: 'redis', cpu: 10, mem: 100, at: ts(t) }]);
    }
    for (let i = 0; i < 5; i++) {
      const t = new Date(THIS_WEEK.getTime() + i * 5 * 60 * 1000);
      seedContainerSnapshots(db, [{ name: 'redis', cpu: 10, mem: 105, at: ts(t) }]);
    }

    const digest = buildDigest(db, config);
    const redisTrend = digest.trends.find(t => t.name === 'redis');
    assert.equal(redisTrend, undefined); // filtered out because not flagged
  });

  it('includes disk warnings above threshold', () => {
    seedDiskSnapshots(db, [
      { mount: '/', total: 100, used: 90, percent: 90, at: ts(NOW) },
    ]);

    const digest = buildDigest(db, config);
    assert.equal(digest.diskWarnings.length, 1);
    assert.equal(digest.diskWarnings[0].used_percent, 90);
  });

  it('no disk warnings below threshold', () => {
    seedDiskSnapshots(db, [
      { mount: '/', total: 100, used: 50, percent: 50, at: ts(NOW) },
    ]);

    const digest = buildDigest(db, config);
    assert.equal(digest.diskWarnings.length, 0);
  });

  it('includes available updates', () => {
    seedUpdateChecks(db, [
      { name: 'nginx', image: 'nginx:alpine', hasUpdate: 1, at: ts(NOW) },
      { name: 'redis', image: 'redis:alpine', hasUpdate: 0, at: ts(NOW) },
    ]);

    const digest = buildDigest(db, config);
    assert.equal(digest.updatesAvailable.length, 1);
    assert.equal(digest.updatesAvailable[0].container_name, 'nginx');
  });

  it('overall status is red with many issues', () => {
    // Downtime
    seedContainerSnapshots(db, [
      { name: 'nginx', status: 'exited', restarts: 5, at: ts(NOW) },
    ]);
    // Disk warning
    seedDiskSnapshots(db, [
      { mount: '/', percent: 95, at: ts(NOW) },
    ]);

    const digest = buildDigest(db, config);
    // 2 issue types (container downtime + restarts) → yellow (<=2)
    assert.equal(digest.overallStatus, 'yellow');
  });

  it('has correct weekNumber', () => {
    const digest = buildDigest(db, config);
    assert.ok(typeof digest.weekNumber === 'number');
    assert.ok(digest.weekNumber >= 1 && digest.weekNumber <= 53);
  });
});
