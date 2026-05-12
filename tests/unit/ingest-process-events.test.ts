import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
const { bootstrap } = require('../../hub/src/db/schema');
const { ingestProcessEvents, MAX_EVENTS_PER_MESSAGE } =
  require('../../hub/src/ingest-process-events');

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  bootstrap(db);
  return db;
}

describe('ingestProcessEvents', () => {
  it('upserts argv_dictionary entries (INSERT OR IGNORE)', () => {
    const db = freshDb();
    ingestProcessEvents(db, 'h1', {
      cycle_at: 'now',
      argv_defs: [
        { argv_hash: 'a', argv: '/bin/ls -la', comm: 'ls' },
        { argv_hash: 'a', argv: '/bin/ls -la', comm: 'ls' },
      ],
      spawns: [], exits: [],
    });
    const rows = db.prepare('SELECT * FROM argv_dictionary').all();
    assert.equal(rows.length, 1);
  });

  it('inserts spawn rows; duplicate is no-op via UNIQUE constraint', () => {
    const db = freshDb();
    const spawn = {
      pid: 100, ppid: 1, argv_hash: 'h',
      started_at: '2026-05-12T00:00:00Z', source: 'host' as const,
    };
    ingestProcessEvents(db, 'h1', {
      cycle_at: 'now', argv_defs: [{ argv_hash: 'h', argv: '/x', comm: 'x' }],
      spawns: [spawn], exits: [],
    });
    ingestProcessEvents(db, 'h1', {
      cycle_at: 'now2', argv_defs: [], spawns: [spawn], exits: [],
    });
    const count = db.prepare('SELECT COUNT(*) AS c FROM process_events').get() as any;
    assert.equal(count.c, 1);
  });

  it('applies exit: fills exited_at, exit_code, lifetime_ms', () => {
    const db = freshDb();
    ingestProcessEvents(db, 'h1', {
      cycle_at: 'now',
      argv_defs: [{ argv_hash: 'h', argv: '/x', comm: 'x' }],
      spawns: [{
        pid: 100, ppid: 1, argv_hash: 'h',
        started_at: '2026-05-12T00:00:00Z', source: 'host',
      }],
      exits: [],
    });
    ingestProcessEvents(db, 'h1', {
      cycle_at: 'now',
      argv_defs: [], spawns: [],
      exits: [{
        pid: 100, started_at: '2026-05-12T00:00:00Z',
        exited_at: '2026-05-12T00:00:05Z', exit_code: 0, lifetime_ms: 5000,
      }],
    });
    const row = db.prepare(
      'SELECT exited_at, exit_code, lifetime_ms FROM process_events WHERE pid=100'
    ).get() as any;
    assert.equal(row.exited_at, '2026-05-12T00:00:05Z');
    assert.equal(row.exit_code, 0);
    assert.equal(row.lifetime_ms, 5000);
  });

  it('orphan exit (no prior spawn) is a no-op', () => {
    const db = freshDb();
    ingestProcessEvents(db, 'h1', {
      cycle_at: 'now', argv_defs: [], spawns: [],
      exits: [{
        pid: 999, started_at: '2026-05-12T00:00:00Z',
        exited_at: '2026-05-12T00:00:01Z', exit_code: null, lifetime_ms: 1000,
      }],
    });
    const count = db.prepare('SELECT COUNT(*) AS c FROM process_events').get() as any;
    assert.equal(count.c, 0);
  });

  it('double exit does not overwrite previously-set exit_code', () => {
    const db = freshDb();
    ingestProcessEvents(db, 'h1', {
      cycle_at: 'now',
      argv_defs: [{ argv_hash: 'h', argv: '/x', comm: 'x' }],
      spawns: [{
        pid: 100, ppid: 1, argv_hash: 'h',
        started_at: '2026-05-12T00:00:00Z', source: 'host',
      }],
      exits: [{
        pid: 100, started_at: '2026-05-12T00:00:00Z',
        exited_at: 'E1', exit_code: 0, lifetime_ms: 1000,
      }],
    });
    ingestProcessEvents(db, 'h1', {
      cycle_at: 'now2', argv_defs: [], spawns: [],
      exits: [{
        pid: 100, started_at: '2026-05-12T00:00:00Z',
        exited_at: 'E2', exit_code: 99, lifetime_ms: 9999,
      }],
    });
    const row = db.prepare(
      'SELECT exited_at, exit_code FROM process_events WHERE pid=100'
    ).get() as any;
    assert.equal(row.exited_at, 'E1');     // first exit wins
    assert.equal(row.exit_code, 0);
  });

  it('rejects oversize messages', () => {
    const db = freshDb();
    const spawns = Array.from({ length: MAX_EVENTS_PER_MESSAGE + 1 }, (_, i) => ({
      pid: i + 1, ppid: 1, argv_hash: 'h',
      started_at: '2026-05-12T00:00:00Z', source: 'host' as const,
    }));
    assert.throws(
      () => ingestProcessEvents(db, 'h1',
        { cycle_at: 'now', argv_defs: [], spawns, exits: [] }),
      /oversize/i
    );
    const count = db.prepare('SELECT COUNT(*) AS c FROM process_events').get() as any;
    assert.equal(count.c, 0, 'no partial ingest');
  });

  it('truncates argv text to 4096 bytes on insert', () => {
    const db = freshDb();
    const long = 'x'.repeat(8000);
    ingestProcessEvents(db, 'h1', {
      cycle_at: 'now',
      argv_defs: [{ argv_hash: 'h', argv: long, comm: 'x' }],
      spawns: [], exits: [],
    });
    const row = db.prepare('SELECT argv FROM argv_dictionary').get() as any;
    assert.equal(row.argv.length, 4096);
  });
});
