const crypto = require('crypto');
const logger = require('../../../shared/utils/logger');

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const failedAttempts = new Map();
const LOCKOUT_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

// L1 in-memory cache for sessions (avoids DB hit on every request)
const sessionCache = new Set();

let _db = null;
function setDb(db) {
  _db = db;
  // Load existing sessions into cache on startup
  try {
    const rows = db.prepare("SELECT token FROM sessions WHERE expires_at > datetime('now')").all();
    for (const r of rows) sessionCache.add(r.token);
    logger.info('auth', `Loaded ${rows.length} active sessions from database`);
  } catch { /* DB not ready */ }
}

// Periodic cleanup
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of failedAttempts) {
    if (now - data.first > LOCKOUT_MS) failedAttempts.delete(ip);
  }
  // Clean expired sessions from DB
  if (_db) {
    try {
      const deleted = _db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
      if (deleted.changes > 0) {
        // Rebuild cache
        sessionCache.clear();
        const rows = _db.prepare("SELECT token FROM sessions WHERE expires_at > datetime('now')").all();
        for (const r of rows) sessionCache.add(r.token);
      }
    } catch { /* DB issue */ }
  }
}, 3600000).unref();

function getAdminPassword() {
  if (_db) {
    try {
      const row = _db.prepare("SELECT value FROM settings WHERE key = 'admin.password'").get();
      if (row && row.value) return row.value;
    } catch { /* DB not ready */ }
  }
  return process.env.INSIGHTD_ADMIN_PASSWORD || '';
}

function isAuthEnabled() {
  return !!getAdminPassword();
}

function isSetupComplete() {
  if (_db) {
    try {
      const row = _db.prepare("SELECT value FROM meta WHERE key = 'setup_complete'").get();
      return row && row.value === 'true';
    } catch { /* DB not ready */ }
  }
  return false;
}

function authenticate(password, ip) {
  const expected = getAdminPassword();
  if (!expected) return null;

  if (ip) {
    const attempts = failedAttempts.get(ip);
    if (attempts && attempts.count >= LOCKOUT_ATTEMPTS && Date.now() - attempts.first < LOCKOUT_MS) {
      return null;
    }
  }

  const a = Buffer.from(password);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    if (ip) {
      const existing = failedAttempts.get(ip);
      if (existing && Date.now() - existing.first < LOCKOUT_MS) {
        existing.count++;
      } else {
        failedAttempts.set(ip, { first: Date.now(), count: 1 });
      }
    }
    return null;
  }

  if (ip) failedAttempts.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');

  // Persist session to SQLite
  if (_db) {
    try {
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString().slice(0, 19).replace('T', ' ');
      _db.prepare('INSERT OR REPLACE INTO sessions (token, expires_at) VALUES (?, datetime(?))').run(token, expiresAt);
    } catch { /* DB issue — session still works in memory */ }
  }
  sessionCache.add(token);
  return token;
}

function validateToken(token) {
  if (!token) return false;

  // Check API keys first (prefixed with insightd_)
  if (token.startsWith('insightd_') && _db) {
    return validateApiKey(token);
  }

  // L1 cache check
  if (sessionCache.has(token)) return true;

  // L2 DB check (in case cache was lost)
  if (_db) {
    try {
      const row = _db.prepare("SELECT token FROM sessions WHERE token = ? AND expires_at > datetime('now')").get(token);
      if (row) {
        sessionCache.add(token);
        return true;
      }
    } catch { /* DB issue */ }
  }

  return false;
}

function logout(token) {
  sessionCache.delete(token);
  if (_db) {
    try { _db.prepare('DELETE FROM sessions WHERE token = ?').run(token); } catch { /* ignore */ }
  }
}

// --- API Keys ---

function validateApiKey(key) {
  if (!_db) return false;
  try {
    const hash = crypto.createHash('sha256').update(key).digest('hex');
    const row = _db.prepare('SELECT id FROM api_keys WHERE key_hash = ?').get(hash);
    if (row) {
      _db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(row.id);
      return true;
    }
  } catch { /* DB issue */ }
  return false;
}

function createApiKey(db, name) {
  const raw = 'insightd_' + crypto.randomBytes(20).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const prefix = raw.slice(0, 17); // insightd_ + first 8 hex chars
  db.prepare('INSERT INTO api_keys (name, key_prefix, key_hash) VALUES (?, ?, ?)').run(name, prefix, hash);
  return { key: raw, prefix };
}

function revokeApiKey(db, id) {
  db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
}

function getApiKeys(db) {
  return db.prepare('SELECT id, name, key_prefix, created_at, last_used_at FROM api_keys ORDER BY created_at DESC').all();
}

function requireAuth(req) {
  if (!isAuthEnabled()) return true;
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return validateToken(token);
}

module.exports = { isAuthEnabled, authenticate, validateToken, requireAuth, setDb, isSetupComplete, logout, createApiKey, revokeApiKey, getApiKeys };
