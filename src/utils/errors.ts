import logger = require('./logger');

/**
 * Wraps an async function so failures are logged but don't crash the process.
 * Returns the result on success, or null on failure.
 */
async function safeCollect<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    logger.error(label, `Collection failed: ${(err as Error).message}`, err);
    return null;
  }
}

module.exports = { safeCollect };
