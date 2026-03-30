const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { createTestDb } = require('../helpers/db');
const { createMockDocker, suppressConsole } = require('../helpers/mocks');

describe('integration: collect and digest', () => {
  let db;
  let restore;

  beforeEach(() => {
    restore = suppressConsole();
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
    restore();
    mock.restoreAll();
  });

  it('full pipeline: collect → ingest → build digest → render', async () => {
    const docker = createMockDocker();
    const config = { hostRoot: '/host', diskWarnPercent: 85 };

    mock.method(fs, 'existsSync', (p) => p === '/host');
    mock.method(fs, 'statSync', () => ({ isDirectory: () => true }));
    mock.method(fs, 'statfsSync', () => ({
      bsize: 4096, blocks: 25000000, bavail: 12500000, type: 0xEF53,
    }));

    // Load modules fresh
    delete require.cache[require.resolve('../../src/collectors/containers')];
    delete require.cache[require.resolve('../../src/collectors/resources')];
    delete require.cache[require.resolve('../../src/collectors/disk')];
    delete require.cache[require.resolve('../../src/digest/builder')];
    delete require.cache[require.resolve('../../src/digest/template')];
    delete require.cache[require.resolve('../../src/ingest')];

    const { collectContainers, _resetRestartState } = require('../../src/collectors/containers');
    const { collectResources, _resetPrevStats } = require('../../src/collectors/resources');
    const { collectDisk } = require('../../src/collectors/disk');
    const { ingestContainers, ingestDisk } = require('../../src/ingest');
    const { buildDigest } = require('../../src/digest/builder');
    const { renderHtml, renderPlainText } = require('../../src/digest/template');

    _resetRestartState();
    _resetPrevStats();

    // Collect (pure functions, no DB)
    const containers = await collectContainers(docker);
    assert.equal(containers.length, 3);

    await collectResources(docker, containers);
    const diskResults = collectDisk(config);
    assert.ok(diskResults.length > 0);

    // Ingest into DB
    ingestContainers(db, 'local', containers);
    ingestDisk(db, 'local', diskResults);

    // Build digest
    const digest = buildDigest(db, config);
    assert.ok(digest.weekNumber);
    assert.ok(digest.overallStatus);
    assert.equal(digest.containers.length, 3);
    assert.ok(digest.disk.length > 0);

    // Render
    const html = renderHtml(digest);
    assert.match(html, /<!DOCTYPE html>/);
    assert.match(html, /nginx/);

    const text = renderPlainText(digest);
    assert.match(text, /Insightd/);
  });

  it('handles empty container environment gracefully', async () => {
    const docker = createMockDocker({ containers: [] });
    const config = { hostRoot: '/nonexistent', diskWarnPercent: 85 };

    delete require.cache[require.resolve('../../src/collectors/containers')];
    delete require.cache[require.resolve('../../src/collectors/disk')];
    delete require.cache[require.resolve('../../src/digest/builder')];

    const { collectContainers, _resetRestartState } = require('../../src/collectors/containers');
    const { collectDisk } = require('../../src/collectors/disk');
    const { buildDigest } = require('../../src/digest/builder');

    _resetRestartState();

    // Mock fs AFTER requiring modules
    mock.method(fs, 'existsSync', () => false);
    mock.method(fs, 'readFileSync', () => 'tmpfs /tmp tmpfs rw 0 0\n');

    const containers = await collectContainers(docker);
    assert.equal(containers.length, 0);

    collectDisk(config);

    const digest = buildDigest(db, config);
    assert.equal(digest.overallStatus, 'green');
    assert.equal(digest.containers.length, 0);
  });
});
