import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
const { bootstrap } = require('../../hub/src/db/schema');
const { handleMqttMessage } = require('../../hub/src/mqtt');

describe('mqtt process_events dispatch', () => {
  it('routes insightd/<host>/process_events into ingest-process-events', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    bootstrap(db);

    const payload = Buffer.from(JSON.stringify({
      cycle_at: 'now',
      argv_defs: [{ argv_hash: 'h', argv: '/bin/ls', comm: 'ls' }],
      spawns: [{
        pid: 100, ppid: 1, argv_hash: 'h',
        started_at: '2026-05-12T00:00:00Z', source: 'host',
      }],
      exits: [],
    }));

    handleMqttMessage(db, 'insightd/host-A/process_events', payload);

    const count = db.prepare(
      `SELECT COUNT(*) AS c FROM process_events WHERE host_id='host-A'`
    ).get() as any;
    assert.equal(count.c, 1);
  });

  it('ignores unknown topics without throwing', () => {
    const db = new Database(':memory:');
    bootstrap(db);
    assert.doesNotThrow(() =>
      handleMqttMessage(db, 'insightd/host-A/unknown_kind', Buffer.from('{}')));
  });
});
