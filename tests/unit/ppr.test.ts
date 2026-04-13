import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { personalizedPageRank } = require('../../hub/src/insights/rca/ppr');

function edge(from: string, to: string, type: string, weight: number) {
  return { from, to, type, weight };
}

describe('personalizedPageRank', () => {
  it('returns empty neighbors when the graph is empty', () => {
    const result = personalizedPageRank([], 'h1/web');
    assert.deepEqual(result.neighbors, []);
  });

  it('returns a direct neighbor as the top result', () => {
    const edges = [edge('h1/web', 'h1/db', 'same_host', 0.3)];
    const result = personalizedPageRank(edges, 'h1/web');
    assert.equal(result.neighbors.length, 1);
    assert.equal(result.neighbors[0]!.entityId, 'h1/db');
  });

  it('ranks stronger edges higher', () => {
    const edges = [
      edge('h1/web', 'h1/cache', 'same_host', 0.3),
      edge('h1/web', 'h1/db', 'same_compose', 0.6),
      edge('h1/web', 'h1/log', 'same_host', 0.3),
    ];
    const result = personalizedPageRank(edges, 'h1/web');
    assert.equal(result.neighbors[0]!.entityId, 'h1/db');
    assert.ok(result.neighbors[0]!.score > result.neighbors[1]!.score);
  });

  it('includes edge types for direct neighbors', () => {
    const edges = [
      edge('h1/web', 'h1/db', 'same_host', 0.3),
      edge('h1/web', 'h1/db', 'metric_corr', 0.8),
    ];
    const result = personalizedPageRank(edges, 'h1/web');
    const db = result.neighbors[0]!;
    assert.deepEqual(db.edgeTypes.sort(), ['metric_corr', 'same_host']);
  });

  it('walks transitively — a 2-hop neighbor still appears with smaller score', () => {
    const edges = [
      edge('h1/web', 'h1/db', 'same_compose', 0.6),
      edge('h1/db', 'h1/cache', 'same_compose', 0.6),
    ];
    const result = personalizedPageRank(edges, 'h1/web', { topK: 5 });
    const ids = result.neighbors.map((n: any) => n.entityId);
    assert.ok(ids.includes('h1/db'));
    assert.ok(ids.includes('h1/cache'));
    // Direct neighbor scores higher than transitive.
    const dbScore = result.neighbors.find((n: any) => n.entityId === 'h1/db')!.score;
    const cacheScore = result.neighbors.find((n: any) => n.entityId === 'h1/cache')!.score;
    assert.ok(dbScore > cacheScore);
  });

  it('respects topK', () => {
    const edges = [
      edge('h1/web', 'h1/a', 'same_host', 0.3),
      edge('h1/web', 'h1/b', 'same_host', 0.3),
      edge('h1/web', 'h1/c', 'same_host', 0.3),
      edge('h1/web', 'h1/d', 'same_host', 0.3),
    ];
    const result = personalizedPageRank(edges, 'h1/web', { topK: 2 });
    assert.equal(result.neighbors.length, 2);
  });

  it('excludes the seed from its own neighbor list', () => {
    const edges = [edge('h1/web', 'h1/db', 'same_host', 0.3)];
    const result = personalizedPageRank(edges, 'h1/web');
    assert.ok(!result.neighbors.find((n: any) => n.entityId === 'h1/web'));
  });

  it('handles a seed not present in any edge', () => {
    const edges = [edge('h1/web', 'h1/db', 'same_host', 0.3)];
    const result = personalizedPageRank(edges, 'h1/ghost');
    assert.deepEqual(result.neighbors, []);
  });
});
