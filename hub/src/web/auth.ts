const crypto = require('crypto');
import logger = require('../../../shared/utils/logger');
import type Database from 'better-sqlite3';
import type { IncomingMessage } from 'http';

interface FailedAttemptData {
  first: number;
  count: number;
}

interface SessionRow {
  token: string;
}

interface SettingRow {
  value: string;
}

interface MetaRow {
  value: string;
}

interface ApiKeyRow {
  id: number;
  name: string;
  key_prefix: string;
  key_hash: string;
  created_at: string;
  last_used_at: string | null;
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const failedAttempts = new Map<string, FailedAttemptData>();
const LOCKOUT_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

// L1 in-memory cache for sessions (avoids DB hit on every request)
const sessionCache = new Set<string>();

let _db: Database.Database | null = null;
function setDb(db: Database.Database): void {
  _db = db;
  // Load existing sessions into cache on startup
  try {
    const rows = db.prepare("SELECT token FROM sessions WHERE expires_at > datetime('now')").all() as SessionRow[];
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
        const rows = _db.prepare("SELECT token FROM sessions WHERE expires_at > datetime('now')").all() as SessionRow[];
        for (const r of rows) sessionCache.add(r.token);
      }
    } catch { /* DB issue */ }
  }
}, 3600000).unref();

function getAdminPassword(): string {
  if (_db) {
    try {
      const row = _db.prepare("SELECT value FROM settings WHERE key = 'admin.password'").get() as SettingRow | undefined;
      if (row && row.value) return row.value;
    } catch { /* DB not ready */ }
  }
  return process.env.INSIGHTD_ADMIN_PASSWORD || '';
}

function isAuthEnabled(): boolean {
  return !!getAdminPassword();
}

function isSetupComplete(): boolean {
  if (_db) {
    try {
      const row = _db.prepare("SELECT value FROM meta WHERE key = 'setup_complete'").get() as MetaRow | undefined;
      return row != null && row.value === 'true';
    } catch { /* DB not ready */ }
  }
  return false;
}

function authenticate(password: string, ip?: string): string | null {
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
  const token = crypto.randomBytes(32).toString('hex') as string;

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

function validateToken(token: string): boolean {
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
      const row = _db.prepare("SELECT token FROM sessions WHERE token = ? AND expires_at > datetime('now')").get(token) as SessionRow | undefined;
      if (row) {
        sessionCache.add(token);
        return true;
      }
    } catch { /* DB issue */ }
  }

  return false;
}

function logout(token: string): void {
  sessionCache.delete(token);
  if (_db) {
    try { _db.prepare('DELETE FROM sessions WHERE token = ?').run(token); } catch { /* ignore */ }
  }
}

// --- API Keys ---

function validateApiKey(key: string): boolean {
  if (!_db) return false;
  try {
    const hash = crypto.createHash('sha256').update(key).digest('hex') as string;
    const row = _db.prepare('SELECT id FROM api_keys WHERE key_hash = ?').get(hash) as { id: number } | undefined;
    if (row) {
      _db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(row.id);
      return true;
    }
  } catch { /* DB issue */ }
  return false;
}

function createApiKey(db: Database.Database, name: string): { key: string; prefix: string } {
  const raw = 'insightd_' + (crypto.randomBytes(20).toString('hex') as string);
  const hash = crypto.createHash('sha256').update(raw).digest('hex') as string;
  const prefix = raw.slice(0, 17); // insightd_ + first 8 hex chars
  db.prepare('INSERT INTO api_keys (name, key_prefix, key_hash) VALUES (?, ?, ?)').run(name, prefix, hash);
  return { key: raw, prefix };
}

function revokeApiKey(db: Database.Database, id: number): void {
  db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
}

function getApiKeys(db: Database.Database): ApiKeyRow[] {
  return db.prepare('SELECT id, name, key_prefix, created_at, last_used_at FROM api_keys ORDER BY created_at DESC').all() as ApiKeyRow[];
}

function requireAuth(req: IncomingMessage): boolean {
  if (!isAuthEnabled()) return true;
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return validateToken(token);
}

module.exports = { isAuthEnabled, authenticate, validateToken, requireAuth, setDb, isSetupComplete, logout, createApiKey, revokeApiKey, getApiKeys };
