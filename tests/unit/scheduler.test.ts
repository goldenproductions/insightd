import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
const cron = require('node-cron');
const { suppressConsole } = require('../helpers/mocks');

describe('startScheduler', () => {
  let startScheduler: Function;
  let restore: () => void;
  let scheduledJobs: any[];

  beforeEach(() => {
    restore = suppressConsole();
    scheduledJobs = [];
    mock.method(cron, 'schedule', (expr: string, fn: Function, opts: any) => {
      scheduledJobs.push({ expr, fn, opts });
    });
    // Clear scheduler and ingest caches
    delete require.cache[require.resolve('../../src/scheduler')];
    delete require.cache[require.resolve('../../src/ingest')];

    // Mock ingest functions since scheduler imports them directly
    const ingest = require('../../src/ingest');
    mock.method(ingest, 'ingestContainers', () => {});
    mock.method(ingest, 'ingestDisk', () => {});
    mock.method(ingest, 'ingestUpdates', () => {});
    mock.method(ingest, 'upsertHost', () => {});

    startScheduler = require('../../src/scheduler').startScheduler;
  });

  afterEach(() => {
    restore();
    mock.restoreAll();
  });

  function createDeps(overrides: any = {}) {
    // Minimal mock db — pruneOldData calls computeRollups which uses db.prepare
    const mockStmt = { run: () => ({ changes: 0 }), get: () => undefined, all: () => [] };
    const mockDb = {
      prepare: () => mockStmt,
      exec: () => {},
    };
    return {
      db: mockDb,
      docker: {},
      config: {
        hostId: 'test-host',
        collectIntervalMinutes: 5,
        digestCron: '0 8 * * 1',
        updateCheckCron: '0 3 * * *',
        timezone: 'UTC',
        ...overrides,
      },
      collectors: {
        collectContainers: mock.fn(async () => []),
        collectResources: mock.fn(async () => []),
        collectDisk: mock.fn(() => []),
        checkUpdates: mock.fn(async () => []),
      },
      digest: {
        buildDigest: mock.fn(() => ({})),
        sendDigest: mock.fn(async () => {}),
      },
    };
  }

  it('schedules 4 cron jobs', () => {
    const deps = createDeps();
    startScheduler(deps);
    assert.equal(scheduledJobs.length, 4);
  });

  it('collection cron matches config interval', () => {
    const deps = createDeps({ collectIntervalMinutes: 10 });
    startScheduler(deps);
    assert.equal(scheduledJobs[0].expr, '*/10 * * * *');
  });

  it('digest cron matches config', () => {
    const deps = createDeps({ digestCron: '0 9 * * 5' });
    startScheduler(deps);
    assert.equal(scheduledJobs[1].expr, '0 9 * * 5');
  });

  it('prune cron runs daily at 03:30', () => {
    const deps = createDeps();
    startScheduler(deps);
    assert.equal(scheduledJobs[2].expr, '30 3 * * *');
  });

  it('update check cron matches config', () => {
    const deps = createDeps({ updateCheckCron: '0 4 * * *' });
    startScheduler(deps);
    assert.equal(scheduledJobs[3].expr, '0 4 * * *');
  });

  it('passes timezone to all cron jobs', () => {
    const deps = createDeps({ timezone: 'Europe/Oslo' });
    startScheduler(deps);
    for (const job of scheduledJobs) {
      assert.equal(job.opts.timezone, 'Europe/Oslo');
    }
  });

  it('runs collection immediately on startup', async () => {
    const deps = createDeps();
    startScheduler(deps);
    await new Promise(r => setTimeout(r, 50));
    assert.ok(deps.collectors.collectContainers.mock.calls.length >= 1);
  });
});
