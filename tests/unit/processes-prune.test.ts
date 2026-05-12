import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
const { bootstrap, pruneOldData } = require('../../hub/src/db/schema');

describe('process-events retention', () => {
  it('deletes process_events older than 7 days', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    bootstrap(db);
    db.prepare(`INSERT INTO argv_dictionary (argv_hash, argv, comm) VALUES ('h','/x','x')`).run();
    db.prepare(`INSERT INTO process_events
       (host_id, pid, ppid, argv_hash, started_at, source)
       VALUES ('h1', 1, 0, 'h', datetime('now', '-8 days'), 'host')`).run();
    db.prepare(`INSERT INTO process_events
       (host_id, pid, ppid, argv_hash, started_at, source)
       VALUES ('h1', 2, 0, 'h', datetime('now', '-1 day'), 'host')`).run();
    pruneOldData(db);
    const rows = db.prepare(`SELECT pid FROM process_events ORDER BY pid`).all();
    assert.deepEqual(rows, [{ pid: 2 }]);
  });

  it('GCs argv_dictionary rows not referenced by process_events', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    bootstrap(db);
    db.prepare(`INSERT INTO argv_dictionary (argv_hash, argv, comm) VALUES ('keep','/k','k'),('drop','/d','d')`).run();
    db.prepare(`INSERT INTO process_events
       (host_id, pid, ppid, argv_hash, started_at, source)
       VALUES ('h1', 1, 0, 'keep', datetime('now'), 'host')`).run();
    pruneOldData(db);
    const hashes = db.prepare(`SELECT argv_hash FROM argv_dictionary ORDER BY argv_hash`).all();
    assert.deepEqual(hashes, [{ argv_hash: 'keep' }]);
  });
});
