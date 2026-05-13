import test from 'node:test';
import assert from 'node:assert/strict';
import type { Registry, Pattern } from '../../src/log-patterns/types';

const { matchLines, matchesImage } = require('../../src/log-patterns/matcher');

function pat(id: string, regex: string, explainsAlert: string[] = []): Pattern {
  return {
    id, fileKey: 'test', title: id, description: null,
    regex: new RegExp(regex), captureNames: [],
    severity: 'warning', insightCategory: 'logs',
    explainsAlert,
  };
}

function registry(patterns: Pattern[]): Registry {
  const byPatternId = new Map(patterns.map(p => [p.id, p] as const));
  return {
    files: [{ fileKey: 'test', title: 't', imageMatchers: [{ raw: '*jellyfin*', mode: 'contains', needle: 'jellyfin' }], patterns }],
    all: patterns,
    byPatternId,
  };
}

const HOST_ID = 'h1';
const CONTAINER = 'jellyfin';

test('matcher emits event for single matching line', () => {
  const reg = registry([pat('media_file_corrupted', 'File ended prematurely')]);
  const events = matchLines(['ok', 'File ended prematurely', 'ok'], 'linuxserver/jellyfin', HOST_ID, CONTAINER, reg);
  assert.equal(events.length, 1);
  assert.equal(events[0].patternId, 'media_file_corrupted');
  assert.equal(events[0].matchedLine, 'File ended prematurely');
  assert.ok(events[0].lineHash);
});

test('matcher fills N=3 context lines around match', () => {
  const reg = registry([pat('m', 'TARGET')]);
  const lines = ['a','b','c','d','TARGET','e','f','g','h'];
  const events = matchLines(lines, 'jellyfin', HOST_ID, CONTAINER, reg);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].contextBefore, ['b','c','d']);
  assert.deepEqual(events[0].contextAfter, ['e','f','g']);
});

test('matcher context shortened at batch edge', () => {
  const reg = registry([pat('m', 'TARGET')]);
  const events = matchLines(['TARGET', 'a', 'b'], 'jellyfin', HOST_ID, CONTAINER, reg);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].contextBefore, []);
  assert.deepEqual(events[0].contextAfter, ['a','b']);
});

test('matcher fills named captures', () => {
  const reg = registry([{
    ...pat('ffmpeg_fatal', '\\[fatal\\]\\s+(?<message>.+)'),
    captureNames: ['message'],
  }]);
  const events = matchLines(['[fatal] decoder failed'], 'jellyfin', HOST_ID, CONTAINER, reg);
  assert.equal(events.length, 1);
  assert.equal(events[0].captures.message, 'decoder failed');
});

test('matcher truncates lines >4KB with marker', () => {
  const reg = registry([pat('m', 'BIG')]);
  const huge = 'BIG' + 'x'.repeat(5000);
  const events = matchLines([huge], 'jellyfin', HOST_ID, CONTAINER, reg);
  assert.equal(events.length, 1);
  assert.ok(events[0].matchedLine.length <= 4096 + 16);
  assert.ok(events[0].matchedLine.endsWith('…[truncated]'));
});

test('matcher skips when image does not match', () => {
  const reg = registry([pat('m', 'whatever')]);
  const events = matchLines(['whatever'], 'postgres:16', HOST_ID, CONTAINER, reg);
  assert.equal(events.length, 0);
});

test('matcher emits one event per matching pattern on same line', () => {
  const reg = registry([pat('a', 'foo'), pat('b', 'foo')]);
  const events = matchLines(['foo'], 'jellyfin', HOST_ID, CONTAINER, reg);
  assert.equal(events.length, 2);
});

test('matchesImage: tag stripped before comparison', () => {
  assert.equal(matchesImage('linuxserver/jellyfin:latest', { raw: '*jellyfin*', mode: 'contains', needle: 'jellyfin' }), true);
  assert.equal(matchesImage('postgres:16-alpine', { raw: 'postgres', mode: 'exact', needle: 'postgres' }), true);
  assert.equal(matchesImage('postgres:16-alpine', { raw: 'redis', mode: 'exact', needle: 'redis' }), false);
});

test('matchesImage: null image returns false', () => {
  assert.equal(matchesImage(null, { raw: '*', mode: 'contains', needle: '' }), false);
});

test('matcher computes stable line_hash', () => {
  const reg = registry([pat('m', 'foo')]);
  const e1 = matchLines(['foo'], 'jellyfin', HOST_ID, CONTAINER, reg);
  const e2 = matchLines(['foo'], 'jellyfin', HOST_ID, CONTAINER, reg);
  assert.equal(e1[0].lineHash, e2[0].lineHash);
});
