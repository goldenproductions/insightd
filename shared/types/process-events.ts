export interface ArgvDef {
  argv_hash: string;
  argv: string;
  comm: string;
}

export interface SpawnEvent {
  pid: number;
  ppid: number;
  argv_hash: string;
  started_at: string;          // ISO-8601 UTC
  source: 'docker' | 'k8s' | 'host';
  container_id?: string;
  pod_uid?: string;
}

export interface ExitEvent {
  pid: number;
  started_at: string;          // join key with prior spawn
  exited_at: string;
  exit_code: number | null;
  lifetime_ms: number;
}

export interface ProcessEventPayload {
  cycle_at: string;
  argv_defs: ArgvDef[];
  spawns: SpawnEvent[];
  exits: ExitEvent[];
}
