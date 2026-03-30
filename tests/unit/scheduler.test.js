const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const cron = require('node-cron');
const { suppressConsole } = require('../helpers/mocks');

describe('startScheduler', () => {
  let startScheduler;
  let restore;
  let scheduledJobs;

  beforeEach(() => {
    restore = suppressConsole();
    scheduledJobs = [];
    mock.method(cron, 'schedule', (expr, fn, opts) => {
      scheduledJobs.push({ expr, fn, opts });
    });
    delete require.cache[require.resolve('../../src/scheduler')];
    startScheduler = require('../../src/scheduler').startScheduler;
  });

  afterEach(() => {
    restore();
    mock.restoreAll();
  });

  function createDeps(overrides = {}) {
    return {
      db: {},
      docker: {},
      config: {
        collectIntervalMinutes: 5,
        digestCron: '0 8 * * 1',
        updateCheckCron: '0 3 * * *',
        timezone: 'UTC',
        ...overrides,
      },
      collectors: {
        collectContainers: mock.fn(async () => []),
        collectResources: mock.fn(async () => {}),
        collectDisk: mock.fn(() => []),
        checkUpdates: mock.fn(async () => {}),
      },
      digest: {
        buildDigest: mock.fn(() => ({})),
        sendDigest: mock.fn(async () => {}),
      },
    };
  }

  it('schedules 3 cron jobs', () => {
    const deps = createDeps();
    startScheduler(deps);
    assert.equal(scheduledJobs.length, 3);
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

  it('update check cron matches config', () => {
    const deps = createDeps({ updateCheckCron: '0 4 * * *' });
    startScheduler(deps);
    assert.equal(scheduledJobs[2].expr, '0 4 * * *');
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
    // Wait a tick for the async runCollection to execute
    await new Promise(r => setTimeout(r, 50));
    assert.ok(deps.collectors.collectContainers.mock.calls.length >= 1);
  });
});
