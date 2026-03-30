const logger = require('./logger');

/**
 * Fetch container logs from Docker.
 * Handles both multiplexed (TTY=false) and raw (TTY=true) output formats.
 *
 * @param {object} docker - dockerode instance
 * @param {string} containerId - container ID or name
 * @param {object} options - { lines: 100, stream: 'both'|'stdout'|'stderr' }
 * @returns {Promise<Array<{ stream: string, timestamp: string, message: string }>>}
 */
async function fetchContainerLogs(docker, containerId, options = {}) {
  const lines = Math.min(Math.max(options.lines || 100, 1), 1000);
  const streamFilter = options.stream || 'both';
  const wantStdout = streamFilter === 'both' || streamFilter === 'stdout';
  const wantStderr = streamFilter === 'both' || streamFilter === 'stderr';

  const container = docker.getContainer(containerId);

  // Check if container uses TTY (affects log format)
  const info = await container.inspect();
  const isTty = info.Config?.Tty || false;

  const logBuffer = await container.logs({
    stdout: wantStdout,
    stderr: wantStderr,
    tail: lines,
    follow: false,
    timestamps: true,
  });

  // dockerode returns a Buffer when follow=false
  const buf = Buffer.isBuffer(logBuffer) ? logBuffer : Buffer.from(logBuffer || '');
  if (buf.length === 0) return [];

  if (isTty) {
    return parseTtyLogs(buf, streamFilter);
  }
  return parseMuxLogs(buf);
}

/**
 * Parse TTY logs (raw text, no multiplexing headers).
 * All lines are considered stdout.
 */
function parseTtyLogs(buf, streamFilter) {
  if (streamFilter === 'stderr') return [];
  const text = buf.toString('utf8');
  return text.split('\n').filter(l => l.length > 0).map(line => {
    const { timestamp, message } = splitTimestamp(line);
    return { stream: 'stdout', timestamp, message };
  });
}

/**
 * Parse multiplexed Docker log stream.
 * Each frame: [streamType(1), 0, 0, 0, size(4 big-endian), payload(size bytes)]
 * streamType: 1=stdout, 2=stderr
 */
function parseMuxLogs(buf) {
  const entries = [];
  let offset = 0;

  while (offset + 8 <= buf.length) {
    const streamType = buf[offset]; // 1=stdout, 2=stderr
    const frameSize = buf.readUInt32BE(offset + 4);

    if (offset + 8 + frameSize > buf.length) break;

    const payload = buf.slice(offset + 8, offset + 8 + frameSize).toString('utf8');
    offset += 8 + frameSize;

    const stream = streamType === 2 ? 'stderr' : 'stdout';

    // Split payload into lines (a frame can contain multiple lines)
    const lines = payload.split('\n').filter(l => l.length > 0);
    for (const line of lines) {
      const { timestamp, message } = splitTimestamp(line);
      entries.push({ stream, timestamp, message });
    }
  }

  return entries;
}

/**
 * Split a Docker log line into timestamp and message.
 * Docker timestamps format: "2026-03-30T12:00:00.123456789Z message..."
 */
function splitTimestamp(line) {
  // Docker timestamp is ISO format followed by a space
  const match = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s(.*)$/);
  if (match) {
    return { timestamp: match[1], message: match[2] };
  }
  return { timestamp: null, message: line };
}

module.exports = { fetchContainerLogs, parseMuxLogs, parseTtyLogs, splitTimestamp };
