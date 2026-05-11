import { createHmac, timingSafeEqual } from 'crypto';

const MAX_AGE_MS = 30 * 24 * 3600 * 1000;

function secret(): string {
  return process.env.INSIGHTD_MUTE_SECRET || 'insightd-default-mute-secret-change-in-prod';
}

function now(): number {
  const offset = Number(process.env.INSIGHTD_TEST_CLOCK_OFFSET_MS || 0);
  return Date.now() + offset;
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url').slice(0, 24);
}

function signMuteToken(alertType: string): string {
  const ts = now();
  const payload = `${alertType}.${ts}`;
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
}

function verifyMuteToken(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  let payload: string;
  try { payload = Buffer.from(parts[0], 'base64url').toString('utf8'); } catch { return null; }
  const expected = sign(payload);
  const got = parts[1];
  if (expected.length !== got.length) return null;
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(got))) return null;
  const sep = payload.lastIndexOf('.');
  if (sep < 0) return null;
  const type = payload.slice(0, sep);
  const ts = Number(payload.slice(sep + 1));
  if (!Number.isFinite(ts)) return null;
  if (now() - ts > MAX_AGE_MS) return null;
  return type;
}

module.exports = { signMuteToken, verifyMuteToken };
