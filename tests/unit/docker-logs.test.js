const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseMuxLogs, parseTtyLogs, splitTimestamp } = require('../../shared/utils/docker-logs');

describe('splitTimestamp', () => {
  it('splits Docker timestamp from message', () => {
    const result = splitTimestamp('2026-03-30T12:00:00.123456789Z Hello world');
    assert.equal(result.timestamp, '2026-03-30T12:00:00.123456789Z');
    assert.equal(result.message, 'Hello world');
  });

  it('returns null timestamp for lines without timestamp', () => {
    const result = splitTimestamp('Just a plain message');
    assert.equal(result.timestamp, null);
    assert.equal(result.message, 'Just a plain message');
  });
});

describe('parseTtyLogs', () => {
  it('parses raw text lines as stdout', () => {
    const buf = Buffer.from(
      '2026-03-30T12:00:00.000Z Line one\n2026-03-30T12:00:01.000Z Line two\n'
    );
    const logs = parseTtyLogs(buf, 'both');
    assert.equal(logs.length, 2);
    assert.equal(logs[0].stream, 'stdout');
    assert.equal(logs[0].message, 'Line one');
    assert.equal(logs[1].message, 'Line two');
  });

  it('returns empty for stderr filter in TTY mode', () => {
    const buf = Buffer.from('2026-03-30T12:00:00.000Z Hello\n');
    const logs = parseTtyLogs(buf, 'stderr');
    assert.deepEqual(logs, []);
  });

  it('handles empty buffer', () => {
    const logs = parseTtyLogs(Buffer.alloc(0), 'both');
    assert.deepEqual(logs, []);
  });
});

describe('parseMuxLogs', () => {
  function makeFrame(streamType, text) {
    const payload = Buffer.from(text);
    const header = Buffer.alloc(8);
    header[0] = streamType; // 1=stdout, 2=stderr
    header.writeUInt32BE(payload.length, 4);
    return Buffer.concat([header, payload]);
  }

  it('parses stdout frames', () => {
    const buf = makeFrame(1, '2026-03-30T12:00:00.000Z Hello stdout\n');
    const logs = parseMuxLogs(buf);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].stream, 'stdout');
    assert.equal(logs[0].message, 'Hello stdout');
  });

  it('parses stderr frames', () => {
    const buf = makeFrame(2, '2026-03-30T12:00:00.000Z Error message\n');
    const logs = parseMuxLogs(buf);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].stream, 'stderr');
    assert.equal(logs[0].message, 'Error message');
  });

  it('parses mixed stdout and stderr', () => {
    const buf = Buffer.concat([
      makeFrame(1, '2026-03-30T12:00:00.000Z stdout line\n'),
      makeFrame(2, '2026-03-30T12:00:01.000Z stderr line\n'),
      makeFrame(1, '2026-03-30T12:00:02.000Z another stdout\n'),
    ]);
    const logs = parseMuxLogs(buf);
    assert.equal(logs.length, 3);
    assert.equal(logs[0].stream, 'stdout');
    assert.equal(logs[1].stream, 'stderr');
    assert.equal(logs[2].stream, 'stdout');
  });

  it('handles empty buffer', () => {
    const logs = parseMuxLogs(Buffer.alloc(0));
    assert.deepEqual(logs, []);
  });

  it('handles frame with multiple lines', () => {
    const buf = makeFrame(1, '2026-03-30T12:00:00.000Z Line 1\n2026-03-30T12:00:01.000Z Line 2\n');
    const logs = parseMuxLogs(buf);
    assert.equal(logs.length, 2);
    assert.equal(logs[0].message, 'Line 1');
    assert.equal(logs[1].message, 'Line 2');
  });

  it('handles truncated frame gracefully', () => {
    const frame = makeFrame(1, '2026-03-30T12:00:00.000Z Hello\n');
    // Truncate the buffer (remove last 3 bytes)
    const truncated = frame.slice(0, frame.length - 3);
    const logs = parseMuxLogs(truncated);
    // Should skip the incomplete frame
    assert.deepEqual(logs, []);
  });
});
