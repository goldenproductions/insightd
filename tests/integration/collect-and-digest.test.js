const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { createTestDb } = require('../helpers/db');
const { DOCKER_CONTAINER_LIST, DOCKER_STATS, DOCKER_IMAGE_INSPECT } = require('../helpers/fixtures');
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

  it('full pipeline: collect → build digest → render', async () => {
    // Setup mocks
    const docker = createMockDocker();
    const config = { hostRoot: '/host', diskWarnPercent: 85 };

    // Mock fs for disk collector
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

    const { collectContainers } = require('../../src/collectors/containers');
    const { collectResources, _resetPrevStats } = require('../../src/collectors/resources');
    const { collectDisk } = require('../../src/collectors/disk');
    const { buildDigest } = require('../../src/digest/builder');
    const { renderHtml, renderPlainText } = require('../../src/digest/template');

    _resetPrevStats();

    // Run collection
    const containers = await collectContainers(db, docker);
    assert.equal(containers.length, 3);

    await collectResources(db, docker, containers);
    const diskResults = collectDisk(db, config);
    assert.ok(diskResults.length > 0);

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
    assert.match(html, /redis/);
    assert.match(html, /postgres/);

    const text = renderPlainText(digest);
    assert.match(text, /Insightd/);
    assert.match(text, /Uptime/);
  });

  it('handles empty container environment gracefully', async () => {
    const docker = createMockDocker({ containers: [] });
    const config = { hostRoot: '/nonexistent', diskWarnPercent: 85 };

    // Load modules BEFORE mocking fs to avoid interfering with require()
    delete require.cache[require.resolve('../../src/collectors/containers')];
    delete require.cache[require.resolve('../../src/collectors/disk')];
    delete require.cache[require.resolve('../../src/digest/builder')];

    const { collectContainers } = require('../../src/collectors/containers');
    const { collectDisk } = require('../../src/collectors/disk');
    const { buildDigest } = require('../../src/digest/builder');

    // Mock fs for fallback path (after modules are loaded)
    mock.method(fs, 'existsSync', () => false);
    mock.method(fs, 'readFileSync', () => 'tmpfs /tmp tmpfs rw 0 0\n');

    const containers = await collectContainers(db, docker);
    assert.equal(containers.length, 0);

    collectDisk(db, config);

    const digest = buildDigest(db, config);
    assert.equal(digest.overallStatus, 'green');
    assert.equal(digest.containers.length, 0);
    assert.equal(digest.summaryLine, 'No critical issues. Good week.');
  });
});
