import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
const { bootstrap, SCHEMA_VERSION, pruneOldData } = require('../../hub/src/db/schema');

function getColumns(db: any, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(r => r.name);
}

describe('schema v47 — template_burst_events', () => {
  it('fresh bootstrap creates template_burst_events with the expected columns', () => {
    const db = new Database(':memory:');
    bootstrap(db);
    const cols = getColumns(db, 'template_burst_events');
    for (const expected of [
      'id', 'template_id', 'host_id', 'container_name', 'image',
      'ts', 'batch_count', 'baseline_rate', 'intensity', 'semantic_tag',
    ]) {
      assert.ok(cols.includes(expected), `template_burst_events has ${expected}`);
    }
    db.close();
  });

  it('migrating from v46 adds template_burst_events', () => {
    const db = new Database(':memory:');
    bootstrap(db);
    db.exec('DROP TABLE template_burst_events');
    db.prepare("UPDATE meta SET value = '46' WHERE key = 'schema_version'").run();
    bootstrap(db);
    const cols = getColumns(db, 'template_burst_events');
    assert.ok(cols.includes('intensity'));
    assert.ok(cols.includes('baseline_rate'));
    const v = (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value;
    assert.equal(parseInt(v, 10), SCHEMA_VERSION);
    db.close();
  });

  it('prune deletes burst events older than 15 days', () => {
    const db = new Database(':memory:');
    bootstrap(db);
    // Insert one row 20 days old, one 5 days old.
    db.prepare(`
      INSERT INTO template_burst_events
        (template_id, host_id, container_name, image, ts, batch_count, baseline_rate, intensity, semantic_tag)
      VALUES
        (1, 'h', 'c', 'img', datetime('now', '-20 days'), 5, 0.1, 50, NULL),
        (1, 'h', 'c', 'img', datetime('now', '-5 days'),  5, 0.1, 50, NULL)
    `).run();
    pruneOldData(db, 30, 365);
    const remaining = (db.prepare('SELECT COUNT(*) AS n FROM template_burst_events').get() as { n: number }).n;
    assert.equal(remaining, 1, 'only the recent burst survives a 15-day TTL');
    db.close();
  });
});
