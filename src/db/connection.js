const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

let db = null;

function getDb(dbPath) {
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

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { getDb, closeDb };
