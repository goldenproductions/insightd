import type { IncomingMessage } from 'http';

const MAX_REQUESTS = 120; // per window
const WINDOW_MS = 60000; // 1 minute
const buckets = new Map<string, { start: number; count: number }>();

function isRateLimited(req: IncomingMessage): boolean {
  const ip = req.socket.remoteAddress || '';
  const now = Date.now();
  let bucket = buckets.get(ip);
  if (!bucket || now - bucket.start > WINDOW_MS) {
    bucket = { start: now, count: 0 };
    buckets.set(ip, bucket);
  }
  bucket.count++;
  return bucket.count > MAX_REQUESTS;
}

// Periodic cleanup of stale buckets (unref so it doesn't prevent process exit)
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of buckets) {
    if (now - bucket.start > WINDOW_MS * 2) buckets.delete(ip);
  }
}, 60000).unref();

module.exports = { isRateLimited };
