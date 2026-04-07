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
  db.pragma('cache_size = -2000'); // 2MB cache
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
