import { createHash } from 'node:crypto';
import logger = require('../../../shared/utils/logger');
import type { ImageMatcher, MatchEvent, Pattern, Registry } from './types';

const MAX_LINE_BYTES = 4096;
const TRUNCATION_MARKER = '…[truncated]';
const CONTEXT_LINES = 3;
const SLOW_BATCH_MS = 100;

function stripTag(image: string): string {
  // Strip everything after the LAST colon — keeps registry prefix intact and removes :tag.
  const idx = image.lastIndexOf(':');
  if (idx < 0) return image;
  return image.slice(0, idx);
}

function matchesImage(image: string | null, m: ImageMatcher): boolean {
  if (image == null) return false;
  const stripped = stripTag(image);
  switch (m.mode) {
    case 'exact':    return stripped === m.needle;
    case 'prefix':   return stripped.startsWith(m.needle);
    case 'suffix':   return stripped.endsWith(m.needle);
    case 'contains': return stripped.includes(m.needle);
  }
}

function truncateLine(line: string): string {
  if (Buffer.byteLength(line, 'utf8') <= MAX_LINE_BYTES) return line;
  const truncated = Buffer.from(line, 'utf8').slice(0, MAX_LINE_BYTES).toString('utf8');
  return truncated + TRUNCATION_MARKER;
}

function hashLine(patternId: string, line: string): string {
  return createHash('sha256').update(patternId).update('\n').update(line).digest('hex').slice(0, 16);
}

function applicablePatterns(image: string | null, registry: Registry): Pattern[] {
  const out: Pattern[] = [];
  for (const file of registry.files) {
    if (!file.imageMatchers.some(m => matchesImage(image, m))) continue;
    out.push(...file.patterns);
  }
  return out;
}

function matchLines(
  lines: string[],
  image: string | null,
  hostId: string,
  containerName: string,
  registry: Registry,
): MatchEvent[] {
  const patterns = applicablePatterns(image, registry);
  if (patterns.length === 0) return [];

  const events: MatchEvent[] = [];
  const started = Date.now();
  let slowestPatternId: string | null = null;
  let slowestMs = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    if (!raw) continue;
    const line = truncateLine(raw);
    for (const pat of patterns) {
      const t0 = Date.now();
      const m = line.match(pat.regex);
      const dt = Date.now() - t0;
      if (dt > slowestMs) { slowestMs = dt; slowestPatternId = pat.id; }
      if (!m) continue;
      const captures: Record<string, string> = {};
      if (m.groups) {
        for (const [k, v] of Object.entries(m.groups)) {
          if (v != null) captures[k] = v;
        }
      }
      const contextBefore = lines.slice(Math.max(0, i - CONTEXT_LINES), i);
      const contextAfter  = lines.slice(i + 1, Math.min(lines.length, i + 1 + CONTEXT_LINES));
      events.push({
        patternId: pat.id,
        hostId,
        containerName,
        image: image ?? null,
        matchedLine: line,
        contextBefore,
        contextAfter,
        captures,
        lineHash: hashLine(pat.id, line),
      });
    }
  }
  const elapsed = Date.now() - started;
  if (elapsed > SLOW_BATCH_MS) {
    logger.warn('log-patterns', `matcher batch took ${elapsed}ms; slowest pattern ${slowestPatternId ?? 'unknown'} ${slowestMs}ms`);
  }
  return events;
}

module.exports = { matchLines, matchesImage, stripTag, applicablePatterns };
