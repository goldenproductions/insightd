import type Database from 'better-sqlite3';
import type { ProcessEventPayload } from '../../shared/types/process-events';

export const MAX_EVENTS_PER_MESSAGE = 10000;
const ARGV_MAX_BYTES = 4096;

export function ingestProcessEvents(
  db: Database.Database,
  hostId: string,
  payload: ProcessEventPayload,
): void {
  const total =
    (payload.argv_defs?.length ?? 0) +
    (payload.spawns?.length ?? 0) +
    (payload.exits?.length ?? 0);
  if (total > MAX_EVENTS_PER_MESSAGE) {
    throw new Error(`oversize process_events payload (${total} > ${MAX_EVENTS_PER_MESSAGE})`);
  }

  const argvIns = db.prepare(
    `INSERT OR IGNORE INTO argv_dictionary (argv_hash, argv, comm) VALUES (?, ?, ?)`
  );
  const spawnIns = db.prepare(`
    INSERT OR IGNORE INTO process_events
      (host_id, container_id, pod_uid, pid, ppid, argv_hash, started_at, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const exitUpd = db.prepare(`
    UPDATE process_events
       SET exited_at = ?, exit_code = ?, lifetime_ms = ?
     WHERE host_id = ? AND pid = ? AND started_at = ? AND exited_at IS NULL
  `);

  const tx = db.transaction(() => {
    for (const def of payload.argv_defs ?? []) {
      argvIns.run(def.argv_hash, def.argv.slice(0, ARGV_MAX_BYTES), def.comm);
    }
    for (const s of payload.spawns ?? []) {
      spawnIns.run(
        hostId, s.container_id ?? null, s.pod_uid ?? null,
        s.pid, s.ppid, s.argv_hash, s.started_at, s.source,
      );
    }
    for (const e of payload.exits ?? []) {
      exitUpd.run(
        e.exited_at, e.exit_code ?? null, e.lifetime_ms,
        hostId, e.pid, e.started_at,
      );
    }
  });

  tx();
}
