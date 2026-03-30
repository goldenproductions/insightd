const crypto = require('crypto');

const sessions = new Map();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function isAuthEnabled() {
  return !!(process.env.INSIGHTD_ADMIN_PASSWORD);
}

function authenticate(password) {
  const expected = process.env.INSIGHTD_ADMIN_PASSWORD;
  if (!expected) return null;

  const a = Buffer.from(password);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

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
