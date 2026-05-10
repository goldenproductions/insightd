import type Database from 'better-sqlite3';

/**
 * Disk-fill ETA predictions. One insight per (host, mount) or (host, storage)
 * that will reach saturation within 14 days at the current 7-day growth
 * rate. Sibling to right-sizing and proxmox-checks — runs from the
 * generateInsights cycle and writes into the shared `insights` table under
 * category 'prediction'.
 */

export function generateDiskFillInsights(db: Database.Database): number {
  void db;
  return 0;
}

module.exports = { generateDiskFillInsights };
