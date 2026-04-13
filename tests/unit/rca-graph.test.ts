import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { createTestDb } = require('../helpers/db');
const { suppressConsole } = require('../helpers/mocks');
const { buildGraph, loadEdges } = require('../../hub/src/insights/rca/graph');

function ts(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function seedContainer(db: any, opts: {
  hostId: string;
  name: string;
  labels?: Record<string, string> | null;
  at: string;
}): void {
  db.prepare(`
    INSERT INTO container_snapshots
    (host_id, container_name, container_id, status, cpu_percent, memory_mb, restart_count, health_status, labels, collected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.hostId, opts.name, 'abc', 'running', 10, 100, 0, 'healthy',
    opts.labels ? JSON.stringify(opts.labels) : null,
    opts.at,
  );
}

describe('RCA graph builder', () => {
  let db: any;
  let restore: () => void;
  const NOW = new Date();

  beforeEach(() => {
    restore = suppressConsole();
    db = createTestDb();
  });

  afterEach(() => {
    restore();
    db.close();
  });

  it('emits no edges when there are no live containers', () => {
    const count = buildGraph(db);
    assert.equal(count, 0);
  });

  it('emits same_host edges between sibling containers on the same host', () => {
    seedContainer(db, { hostId: 'h1', name: 'web', at: ts(NOW) });
    seedContainer(db, { hostId: 'h1', name: 'db', at: ts(NOW) });
    seedContainer(db, { hostId: 'h2', name: 'cache', at: ts(NOW) });

    buildGraph(db);
    const edges = loadEdges(db);

    const hostEdges = edges.filter((e: any) => e.type === 'same_host');
    assert.equal(hostEdges.length, 1, `expected one same_host edge, got ${hostEdges.length}`);
    const e = hostEdges[0]!;
    assert.ok(
      (e.from === 'h1/web' && e.to === 'h1/db') ||
      (e.from === 'h1/db' && e.to === 'h1/web'),
    );
  });

  it('emits same_compose edges when containers share a project label', () => {
    seedContainer(db, {
      hostId: 'h1', name: 'web',
      labels: { 'com.docker.compose.project': 'myapp' },
      at: ts(NOW),
    });
    seedContainer(db, {
      hostId: 'h1', name: 'db',
      labels: { 'com.docker.compose.project': 'myapp' },
      at: ts(NOW),
    });

    buildGraph(db);
    const edges = loadEdges(db);
    const composeEdges = edges.filter((e: any) => e.type === 'same_compose');
    assert.equal(composeEdges.length, 1);
    // Compose edges have a stronger weight than same_host.
    assert.ok(composeEdges[0]!.weight > 0.5);
  });

  it('emits same_group edges for service-group members', () => {
    seedContainer(db, { hostId: 'h1', name: 'web', at: ts(NOW) });
    seedContainer(db, { hostId: 'h2', name: 'api', at: ts(NOW) });

    db.prepare('INSERT INTO service_groups (name) VALUES (?)').run('frontend');
    const gid = db.prepare('SELECT id FROM service_groups WHERE name = ?').get('frontend').id;
    const insMember = db.prepare('INSERT INTO service_group_members (group_id, host_id, container_name) VALUES (?, ?, ?)');
    insMember.run(gid, 'h1', 'web');
    insMember.run(gid, 'h2', 'api');

    buildGraph(db);
    const edges = loadEdges(db);
    const groupEdges = edges.filter((e: any) => e.type === 'same_group');
    assert.equal(groupEdges.length, 1);
  });

  it('replaces rca_edges on rebuild (idempotent)', () => {
    seedContainer(db, { hostId: 'h1', name: 'a', at: ts(NOW) });
    seedContainer(db, { hostId: 'h1', name: 'b', at: ts(NOW) });
    buildGraph(db);
    const firstCount = loadEdges(db).length;
    buildGraph(db);
    const secondCount = loadEdges(db).length;
    assert.equal(firstCount, secondCount);
  });

  it('ignores stale containers (>1h since last seen)', () => {
    const oldTs = ts(new Date(Date.now() - 2 * 3600_000));
    seedContainer(db, { hostId: 'h1', name: 'old', at: oldTs });
    seedContainer(db, { hostId: 'h1', name: 'current', at: ts(NOW) });

    buildGraph(db);
    // One container alone has no peers, so no edges.
    const edges = loadEdges(db);
    assert.equal(edges.length, 0);
  });
});
