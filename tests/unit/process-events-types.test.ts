import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ArgvDef, SpawnEvent, ExitEvent, ProcessEventPayload,
} from '../../shared/types/process-events';

describe('process-events shared types', () => {
  it('ArgvDef has hash + argv + comm', () => {
    const def: ArgvDef = { argv_hash: 'abc123', argv: '/bin/ls', comm: 'ls' };
    assert.equal(def.argv_hash, 'abc123');
    assert.equal(def.argv, '/bin/ls');
    assert.equal(def.comm, 'ls');
  });

  it('SpawnEvent has pid, ppid, argv_hash, started_at, source and optional container_id/pod_uid', () => {
    const ev: SpawnEvent = {
      pid: 1, ppid: 0, argv_hash: 'x',
      started_at: '2026-05-12T00:00:00Z',
      source: 'host',
    };
    assert.equal(ev.pid, 1);
    assert.equal(ev.ppid, 0);
    assert.equal(ev.argv_hash, 'x');
    assert.equal(ev.started_at, '2026-05-12T00:00:00Z');
    assert.equal(ev.source, 'host');
    assert.equal(ev.container_id, undefined);
    assert.equal(ev.pod_uid, undefined);
  });

  it('ExitEvent has all five fields including null exit_code', () => {
    const ev: ExitEvent = {
      pid: 1, started_at: 's', exited_at: 'e', exit_code: null, lifetime_ms: 100,
    };
    assert.equal(ev.pid, 1);
    assert.equal(ev.started_at, 's');
    assert.equal(ev.exited_at, 'e');
    assert.equal(ev.exit_code, null);
    assert.equal(ev.lifetime_ms, 100);
  });

  it('ProcessEventPayload has cycle_at, argv_defs, spawns, exits', () => {
    const p: ProcessEventPayload = { cycle_at: 'now', argv_defs: [], spawns: [], exits: [] };
    assert.equal(p.cycle_at, 'now');
    assert.deepEqual(p.argv_defs, []);
    assert.deepEqual(p.spawns, []);
    assert.deepEqual(p.exits, []);
  });
});
