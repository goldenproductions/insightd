const crypto = require('crypto');

const sessions = new Map();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const failedAttempts = new Map();
const LOCKOUT_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

// Periodic cleanup of expired sessions and lockouts
setInterval(() => {
  const now = Date.now();
  for (const [token, created] of sessions) {
    if (now - created > SESSION_TTL_MS) sessions.delete(token);
  }
  for (const [ip, data] of failedAttempts) {
    if (now - data.first > LOCKOUT_MS) failedAttempts.delete(ip);
  }
}, 3600000).unref();

function isAuthEnabled() {
  return !!(process.env.INSIGHTD_ADMIN_PASSWORD);
}

function authenticate(password, ip) {
  const expected = process.env.INSIGHTD_ADMIN_PASSWORD;
  if (!expected) return null;

  // Brute force protection
  if (ip) {
    const attempts = failedAttempts.get(ip);
    if (attempts && attempts.count >= LOCKOUT_ATTEMPTS && Date.now() - attempts.first < LOCKOUT_MS) {
      return null;
    }
  }

  const a = Buffer.from(password);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    // Track failed attempt
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

  // Success — clear failed attempts
  if (ip) failedAttempts.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now());
  return token;
}

function validateToken(token) {
  if (!token) return false;
  const created = sessions.get(token);
  if (!created) return false;
  if (Date.now() - created > SESSION_TTL_MS) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function requireAuth(req) {
  if (!isAuthEnabled()) return false;
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return validateToken(token);
}

module.exports = { isAuthEnabled, authenticate, validateToken, requireAuth };
