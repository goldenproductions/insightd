import Database = require('better-sqlite3');
import fs = require('fs');
import path = require('path');
import logger = require('../../../shared/utils/logger');

let db: Database.Database | null = null;

function getDb(dbPath: string): Database.Database {
  if (db) return db;

  // Ensure data directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);

  // Performance pragmas
  db.pragma('journal_mode = WAL');
  // 64 MB page cache (negative = KB). DBs grow to ~100 MB in real installs, so
  // fitting most of the working set in SQLite's own cache makes cold queries
  // fast without depending on the OS page cache surviving a restart.
  db.pragma('cache_size = -65536');
  // Memory-map up to 256 MB of the database. Reads become direct memory
  // accesses once pages are resident, which is dramatically faster than
  // the regular I/O path for large scans on cold cache.
  db.pragma('mmap_size = 268435456');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  logger.info('db', `Opened database at ${dbPath}`);
  return db;
}

function closeDb(): void {
  if (db) {
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* ignore if already closed */ }
    db.close();
    db = null;
    logger.info('db', 'Database closed (WAL checkpointed)');
  }
}

module.exports = { getDb, closeDb };
