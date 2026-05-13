# Log-pattern framework implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a hub-side image-aware log-pattern matching framework that surfaces matched lines as insights AND stamps related alerts with `explained_by_pattern_event_id`. First pattern ships for Jellyfin (field-validated). Stdout only in this PR; file tailing deferred.

**Architecture:** YAML registry in `shared/log-patterns/` loaded eagerly on hub boot. `hub/src/log-patterns/{loader,matcher,events}.ts` are the canonical entry points. Match hook lives in `logCache.ts` write path (runs on every log batch already pulled by existing triggers — no new bandwidth). Persisted matches in new `log_pattern_events` table; insights materialize from that table; alert stamping consults it in `processAlerts`. Existing Drain `templateClassifier` untouched.

**Tech Stack:** Node 20, TypeScript (strict), better-sqlite3 (schema v54), `js-yaml` (new dep), `node:test` via `tsx`, React 19 + Tailwind v4 frontend.

**Spec:** [`docs/superpowers/specs/2026-05-13-log-pattern-framework-design.md`](../specs/2026-05-13-log-pattern-framework-design.md).

---

## File structure

```
shared/log-patterns/
  jellyfin.yaml              ← NEW. First pattern set.
  CONTRIBUTING.md            ← NEW. YAML schema + acceptance criteria.

hub/src/log-patterns/
  types.ts                   ← NEW. Pattern / Registry / MatchEvent interfaces.
  loader.ts                  ← NEW. loadRegistry(rootDir): Registry. Eager regex compile + validation.
  matcher.ts                 ← NEW. matchLines(lines, image, registry): MatchEvent[].
  events.ts                  ← NEW. recordMatch / findRecent / findForAlertType DB helpers.

hub/src/db/schema.ts          ← edit: bump v54, add log_pattern_events + alert_state column.
src/db/schema.ts              ← edit: mirror schema v54 in standalone module.
hub/src/db/schema.ts pruneOldData ← edit: prune log_pattern_events past retention.

hub/src/insights/diagnosis/logCache.ts ← edit: matcher hook after templateClassifier.
hub/src/insights/detector.ts          ← edit: materialize log_pattern_match insights.
hub/src/alerts/evaluator.ts processAlerts ← edit: stamp explained_by_pattern_event_id.

hub/src/insights/explain.ts          ← edit: log_match extras block path.
hub/src/insights/explain-types.ts    ← edit: LogMatchBlock added to ExtraBlock union.
hub/src/web/frontend/src/types/api.ts ← edit: mirror ExplainLogMatchBlock.
hub/src/web/frontend/src/components/insights/LogMatchBlock.tsx ← NEW.
hub/src/web/frontend/src/components/insights/ExpandedBody.tsx  ← edit: dispatch log_match block.
hub/src/web/frontend/src/pages/alerts/... ← edit: chip on rows with explained_by_pattern_event_id.

hub/src/config.ts             ← edit: 3 env knobs.
package.json (hub)            ← edit: add js-yaml.

hub/tests/log-patterns/loader.test.ts   ← NEW.
hub/tests/log-patterns/matcher.test.ts  ← NEW.
hub/tests/log-patterns/events.test.ts   ← NEW.
hub/tests/integration/log-patterns-pipeline.test.ts ← NEW.
```

---

## Task 1: Add `js-yaml` dependency + types module

**Files:**
- Modify: `hub/package.json`
- Create: `hub/src/log-patterns/types.ts`

- [ ] **Step 1.1: Verify js-yaml is not already a dependency**

```bash
grep '"js-yaml"' /home/andreas/insightd/hub/package.json /home/andreas/insightd/package.json
```
Expected: no match. (If it IS already present, skip Step 1.2 and just confirm version is `^4.x`.)

- [ ] **Step 1.2: Install js-yaml in the hub package**

```bash
cd /home/andreas/insightd/hub && npm install js-yaml@^4 && npm install --save-dev @types/js-yaml
```

- [ ] **Step 1.3: Create `hub/src/log-patterns/types.ts`**

```ts
// Shared types for the log-pattern framework.
// Frontend mirrors the wire-facing shape in src/types/api.ts.

export type PatternSeverity = 'info' | 'warning' | 'critical';

export interface Pattern {
  /** Globally unique kebab-case id. */
  id: string;
  /** File this pattern came from (filename without .yaml). */
  fileKey: string;
  /** Human-readable title for UI rendering. */
  title: string;
  /** Optional long-form description for tooltips / detail views. */
  description: string | null;
  /** Pre-compiled regex (built eagerly by the loader). */
  regex: RegExp;
  /** Declared named groups expected in the regex. */
  captureNames: string[];
  /** Drives insight severity. */
  severity: PatternSeverity;
  /** Insight category (defaults to 'logs'). */
  insightCategory: string;
  /** Alert types this pattern explains. Stamped onto matching alert_state rows. */
  explainsAlert: string[];
}

export interface ImageMatcher {
  /** Raw images: entry from YAML (e.g. "*jellyfin*" or "linuxserver/jellyfin"). */
  raw: string;
  /** Pre-computed mode for fast matching. */
  mode: 'exact' | 'prefix' | 'suffix' | 'contains';
  /** Comparison value (with * stripped if mode != 'exact'). */
  needle: string;
}

export interface PatternFile {
  fileKey: string;
  title: string;
  imageMatchers: ImageMatcher[];
  patterns: Pattern[];
}

export interface Registry {
  files: PatternFile[];
  /** Flat list of every loaded pattern across all files. */
  all: Pattern[];
  /** Index for fast image-keyed lookup. */
  byPatternId: Map<string, Pattern>;
}

export interface MatchEvent {
  patternId: string;
  hostId: string;
  containerName: string;
  image: string | null;
  matchedLine: string;
  contextBefore: string[];
  contextAfter: string[];
  captures: Record<string, string>;
  lineHash: string;
}
```

- [ ] **Step 1.4: Typecheck**

```bash
cd /home/andreas/insightd/hub && npx tsc --noEmit 2>&1 | tail -5
```
Expected: clean.

- [ ] **Step 1.5: Commit**

```bash
cd /home/andreas/insightd
git add hub/package.json hub/package-lock.json hub/src/log-patterns/types.ts
git commit -m "feat(log-patterns): types + js-yaml dep (#263)"
```

---

## Task 2: Registry loader (TDD)

**Files:**
- Create: `hub/src/log-patterns/loader.ts`
- Create: `hub/tests/log-patterns/loader.test.ts`

- [ ] **Step 2.1: Write the failing test**

Create `hub/tests/log-patterns/loader.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { loadRegistry } = require('../../src/log-patterns/loader');

function freshDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'lpat-'));
}

const JELLYFIN_YAML = `
images:
  - "*jellyfin*"
title: "Jellyfin"
patterns:
  - id: media_file_corrupted
    title: "Media file ended prematurely"
    description: "ffmpeg or libavformat reports premature end."
    regex: 'File ended prematurely|Premature end of (?:file|stream)'
    severity: warning
    insight_category: logs
    explains_alert:
      - respawn_loop
      - container_unhealthy
  - id: ffmpeg_fatal
    title: "FFmpeg fatal error"
    regex: '\\\\[fatal\\\\]\\\\s+(?<message>.+)'
    captures:
      - message
    severity: warning
`;

test('loader parses jellyfin.yaml into a registry', () => {
  const dir = freshDir();
  try {
    writeFileSync(path.join(dir, 'jellyfin.yaml'), JELLYFIN_YAML);
    const registry = loadRegistry(dir);
    assert.equal(registry.all.length, 2);
    const corrupted = registry.byPatternId.get('media_file_corrupted');
    assert.ok(corrupted);
    assert.deepEqual(corrupted.explainsAlert, ['respawn_loop', 'container_unhealthy']);
    assert.equal(corrupted.severity, 'warning');
    assert.equal(corrupted.insightCategory, 'logs');
    assert.ok(corrupted.regex.test('File ended prematurely'));
    assert.equal(registry.files[0].imageMatchers[0].mode, 'contains');
    assert.equal(registry.files[0].imageMatchers[0].needle, 'jellyfin');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('loader skips files with missing images field', () => {
  const dir = freshDir();
  try {
    writeFileSync(path.join(dir, 'bad.yaml'), `title: bad\npatterns: []\n`);
    const registry = loadRegistry(dir);
    assert.equal(registry.files.length, 0);
    assert.equal(registry.all.length, 0);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('loader skips patterns with malformed regex; siblings still load', () => {
  const dir = freshDir();
  try {
    writeFileSync(path.join(dir, 'mix.yaml'),
      `images: ["*"]\ntitle: mix\npatterns:\n` +
      `  - { id: bad, regex: "(", severity: warning }\n` +
      `  - { id: good, regex: "ok", severity: warning }\n`);
    const registry = loadRegistry(dir);
    assert.equal(registry.all.length, 1);
    assert.equal(registry.all[0].id, 'good');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('loader rejects duplicate pattern_id across files', () => {
  const dir = freshDir();
  try {
    writeFileSync(path.join(dir, 'a.yaml'),
      `images: ["*"]\ntitle: a\npatterns:\n  - { id: dup, regex: "x", severity: warning }\n`);
    writeFileSync(path.join(dir, 'b.yaml'),
      `images: ["*"]\ntitle: b\npatterns:\n  - { id: dup, regex: "y", severity: warning }\n`);
    const registry = loadRegistry(dir);
    assert.equal(registry.all.length, 1, 'second occurrence of dup should be rejected');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('loader returns empty registry for missing/empty directory', () => {
  const dir = freshDir();
  try {
    const registry = loadRegistry(dir);
    assert.equal(registry.all.length, 0);
    rmSync(dir, { recursive: true });
    const registry2 = loadRegistry(dir);
    assert.equal(registry2.all.length, 0);
  } catch {
    // rmSync may already have removed the dir
  }
});

test('loader image glob: prefix, suffix, contains, exact', () => {
  const dir = freshDir();
  try {
    writeFileSync(path.join(dir, 'globs.yaml'),
      `images: ["prefix*", "*suffix", "*middle*", "exact"]\n` +
      `title: g\npatterns: []\n`);
    const registry = loadRegistry(dir);
    const file = registry.files[0];
    const modes = file.imageMatchers.map(m => m.mode);
    assert.deepEqual(modes, ['prefix', 'suffix', 'contains', 'exact']);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
```

- [ ] **Step 2.2: Run test, expect FAIL (module not found)**

```bash
cd /home/andreas/insightd/hub && npx tsx --test tests/log-patterns/loader.test.ts 2>&1 | tail -5
```

- [ ] **Step 2.3: Implement `hub/src/log-patterns/loader.ts`**

```ts
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import logger = require('../../../shared/utils/logger');
import type { Pattern, PatternFile, Registry, ImageMatcher, PatternSeverity } from './types';

const VALID_SEVERITIES = new Set<PatternSeverity>(['info', 'warning', 'critical']);

function parseImageMatcher(raw: string): ImageMatcher {
  const starPrefix = raw.startsWith('*');
  const starSuffix = raw.endsWith('*');
  if (starPrefix && starSuffix) return { raw, mode: 'contains', needle: raw.slice(1, -1) };
  if (starSuffix) return { raw, mode: 'prefix', needle: raw.slice(0, -1) };
  if (starPrefix) return { raw, mode: 'suffix', needle: raw.slice(1) };
  return { raw, mode: 'exact', needle: raw };
}

function extractNamedGroups(re: RegExp): string[] {
  const src = re.source;
  const matches = Array.from(src.matchAll(/\(\?<([A-Za-z_][A-Za-z0-9_]*)>/g));
  return matches.map(m => m[1]);
}

function loadOneFile(filePath: string, seenPatternIds: Set<string>): PatternFile | null {
  const fileKey = path.basename(filePath, path.extname(filePath));
  let parsed: any;
  try {
    parsed = yaml.load(readFileSync(filePath, 'utf8'));
  } catch (err) {
    logger.warn('log-patterns', `failed to parse ${filePath}: ${(err as Error).message}`);
    return null;
  }
  if (!parsed || typeof parsed !== 'object') {
    logger.warn('log-patterns', `${filePath} is not an object`);
    return null;
  }
  if (!Array.isArray(parsed.images) || parsed.images.length === 0) {
    logger.warn('log-patterns', `${filePath} missing or empty 'images' field`);
    return null;
  }
  const imageMatchers = (parsed.images as string[]).map(parseImageMatcher);
  const title = typeof parsed.title === 'string' ? parsed.title : fileKey;
  const rawPatterns = Array.isArray(parsed.patterns) ? parsed.patterns : [];

  const patterns: Pattern[] = [];
  for (const p of rawPatterns) {
    if (!p || typeof p !== 'object') continue;
    if (typeof p.id !== 'string' || !p.id) {
      logger.warn('log-patterns', `${fileKey}: pattern missing 'id', skipped`);
      continue;
    }
    if (seenPatternIds.has(p.id)) {
      logger.warn('log-patterns', `${fileKey}: duplicate pattern_id '${p.id}' rejected`);
      continue;
    }
    if (typeof p.regex !== 'string') {
      logger.warn('log-patterns', `${fileKey}: pattern '${p.id}' missing 'regex', skipped`);
      continue;
    }
    let compiled: RegExp;
    try {
      compiled = new RegExp(p.regex);
    } catch (err) {
      logger.warn('log-patterns', `${fileKey}: pattern '${p.id}' regex compile failed: ${(err as Error).message}`);
      continue;
    }
    const severity: PatternSeverity = VALID_SEVERITIES.has(p.severity) ? p.severity : 'warning';
    const declaredCaptures = Array.isArray(p.captures) ? (p.captures as string[]).filter(c => typeof c === 'string') : [];
    const actualGroups = extractNamedGroups(compiled);
    for (const name of declaredCaptures) {
      if (!actualGroups.includes(name)) {
        logger.warn('log-patterns', `${fileKey}: pattern '${p.id}' declares capture '${name}' not present in regex`);
      }
    }
    const explainsAlert = Array.isArray(p.explains_alert) ? (p.explains_alert as string[]).filter(s => typeof s === 'string') : [];
    const insightCategory = typeof p.insight_category === 'string' ? p.insight_category : 'logs';
    const knownFields = new Set(['id', 'title', 'description', 'regex', 'captures', 'severity', 'insight_category', 'explains_alert']);
    for (const key of Object.keys(p)) {
      if (!knownFields.has(key)) logger.warn('log-patterns', `${fileKey}: pattern '${p.id}' has unknown field '${key}'`);
    }

    patterns.push({
      id: p.id,
      fileKey,
      title: typeof p.title === 'string' ? p.title : p.id,
      description: typeof p.description === 'string' ? p.description : null,
      regex: compiled,
      captureNames: actualGroups,
      severity,
      insightCategory,
      explainsAlert,
    });
    seenPatternIds.add(p.id);
  }
  return { fileKey, title, imageMatchers, patterns };
}

function loadRegistry(rootDir: string): Registry {
  const files: PatternFile[] = [];
  const all: Pattern[] = [];
  const byPatternId = new Map<string, Pattern>();
  const seenPatternIds = new Set<string>();

  if (!existsSync(rootDir)) {
    logger.warn('log-patterns', `registry dir not found: ${rootDir}`);
    return { files, all, byPatternId };
  }
  let entries: string[] = [];
  try {
    entries = readdirSync(rootDir).filter(n => n.endsWith('.yaml') || n.endsWith('.yml'));
  } catch (err) {
    logger.warn('log-patterns', `failed to read registry dir ${rootDir}: ${(err as Error).message}`);
    return { files, all, byPatternId };
  }
  for (const name of entries.sort()) {
    const fp = path.join(rootDir, name);
    try {
      if (!statSync(fp).isFile()) continue;
    } catch { continue; }
    const file = loadOneFile(fp, seenPatternIds);
    if (!file) continue;
    files.push(file);
    for (const pat of file.patterns) {
      all.push(pat);
      byPatternId.set(pat.id, pat);
    }
  }
  return { files, all, byPatternId };
}

module.exports = { loadRegistry, parseImageMatcher, extractNamedGroups };
```

- [ ] **Step 2.4: Run test, expect PASS**

```bash
cd /home/andreas/insightd/hub && npx tsx --test tests/log-patterns/loader.test.ts 2>&1 | tail -10
```
Expected: 6 pass.

- [ ] **Step 2.5: Commit**

```bash
cd /home/andreas/insightd
git add hub/src/log-patterns/loader.ts hub/tests/log-patterns/loader.test.ts
git commit -m "feat(log-patterns): YAML registry loader (#263)"
```

---

## Task 3: Matcher (TDD)

**Files:**
- Create: `hub/src/log-patterns/matcher.ts`
- Create: `hub/tests/log-patterns/matcher.test.ts`

- [ ] **Step 3.1: Write the failing test**

Create `hub/tests/log-patterns/matcher.test.ts`:

```ts
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
```

- [ ] **Step 3.2: Run test, expect FAIL**

```bash
cd /home/andreas/insightd/hub && npx tsx --test tests/log-patterns/matcher.test.ts
```

- [ ] **Step 3.3: Implement `hub/src/log-patterns/matcher.ts`**

```ts
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
  // Don't strip if the colon is part of a port number in registry (rare but possible) — match conservatively
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
```

- [ ] **Step 3.4: Run test, expect PASS**

```bash
cd /home/andreas/insightd/hub && npx tsx --test tests/log-patterns/matcher.test.ts 2>&1 | tail -10
```
Expected: 10 pass.

- [ ] **Step 3.5: Commit**

```bash
cd /home/andreas/insightd
git add hub/src/log-patterns/matcher.ts hub/tests/log-patterns/matcher.test.ts
git commit -m "feat(log-patterns): matcher with context + captures + truncation (#263)"
```

---

## Task 4: Schema v54 — `log_pattern_events` table + `alert_state` column

**Files:**
- Modify: `hub/src/db/schema.ts`
- Modify: `src/db/schema.ts` (standalone mode mirror)

- [ ] **Step 4.1: Read the current schema version and migration pattern**

```bash
grep -n "SCHEMA_VERSION\|v53\|v52\|CURRENT_VERSION\|currentVersion" /home/andreas/insightd/hub/src/db/schema.ts | head -10
```
Note the location of the version constant and the migration function structure (likely a switch on version number or numbered migration blocks).

- [ ] **Step 4.2: Add the table + column in the bootstrap block**

In `hub/src/db/schema.ts`, locate the CREATE TABLE for `insights` (around line 556) and insert these statements next to the other v54-era tables:

```sql
CREATE TABLE IF NOT EXISTS log_pattern_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  host_id         TEXT NOT NULL,
  container_name  TEXT NOT NULL,
  image           TEXT,
  pattern_id      TEXT NOT NULL,
  matched_line    TEXT NOT NULL,
  context_before  TEXT,
  context_after   TEXT,
  captures        TEXT,
  line_hash       TEXT NOT NULL,
  fired_at        TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at    TEXT NOT NULL DEFAULT (datetime('now')),
  occurrences     INTEGER NOT NULL DEFAULT 1,
  UNIQUE (host_id, container_name, pattern_id, line_hash)
);
CREATE INDEX IF NOT EXISTS idx_lpe_container ON log_pattern_events (host_id, container_name, fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_lpe_pattern   ON log_pattern_events (pattern_id, fired_at DESC);
```

Also locate the `alert_state` CREATE TABLE and ADD COLUMN list. Add:

```sql
ALTER TABLE alert_state ADD COLUMN explained_by_pattern_event_id INTEGER;
```

- [ ] **Step 4.3: Add a migration block bumping CURRENT_VERSION from 53 to 54**

Follow the existing pattern (look for the v52→v53 migration as a template). At the top, bump the version constant:

```ts
const CURRENT_VERSION = 54;
```

Add a migration block that runs only when current_user_version < 54:

```ts
if (currentVersion < 54) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS log_pattern_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id         TEXT NOT NULL,
      container_name  TEXT NOT NULL,
      image           TEXT,
      pattern_id      TEXT NOT NULL,
      matched_line    TEXT NOT NULL,
      context_before  TEXT,
      context_after   TEXT,
      captures        TEXT,
      line_hash       TEXT NOT NULL,
      fired_at        TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at    TEXT NOT NULL DEFAULT (datetime('now')),
      occurrences     INTEGER NOT NULL DEFAULT 1,
      UNIQUE (host_id, container_name, pattern_id, line_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_lpe_container ON log_pattern_events (host_id, container_name, fired_at DESC);
    CREATE INDEX IF NOT EXISTS idx_lpe_pattern   ON log_pattern_events (pattern_id, fired_at DESC);
  `);
  try { db.exec('ALTER TABLE alert_state ADD COLUMN explained_by_pattern_event_id INTEGER'); }
  catch { /* column already exists */ }
}
```

The exact placement depends on existing migration structure — read the existing code to match the convention.

- [ ] **Step 4.4: Extend `pruneOldData` to delete old `log_pattern_events`**

Locate `pruneOldData` in `hub/src/db/schema.ts` and append, scaling retention with `rawDays` or hard-coding 7 days to match the issue (the spec says retention is its own env knob — defer wiring the env knob here; just use 7 days literally and let the env knob land in Task 12):

```ts
db.prepare("DELETE FROM log_pattern_events WHERE fired_at < datetime('now', '-7 days')").run();
```

- [ ] **Step 4.5: Mirror the same changes in `src/db/schema.ts`**

```bash
sed -n '1,5p' /home/andreas/insightd/src/db/schema.ts
```
Read the standalone schema and apply the parallel changes (bootstrap CREATE TABLE + migration block bumping to v54 + pruneOldData extension if present).

- [ ] **Step 4.6: Typecheck**

```bash
cd /home/andreas/insightd/hub && npx tsc --noEmit 2>&1 | tail -5
```

- [ ] **Step 4.7: Run the full test suite**

```bash
cd /home/andreas/insightd && npm test 2>&1 | tail -10
```
Expected: no regression. (Schema bootstrap is used by many tests — any breakage shows up here.)

- [ ] **Step 4.8: Commit**

```bash
cd /home/andreas/insightd
git add hub/src/db/schema.ts src/db/schema.ts
git commit -m "feat(db): schema v54 — log_pattern_events + alert_state.explained_by_pattern_event_id (#263)"
```

---

## Task 5: Events module (TDD)

**Files:**
- Create: `hub/src/log-patterns/events.ts`
- Create: `hub/tests/log-patterns/events.test.ts`

- [ ] **Step 5.1: Write the failing test**

Create `hub/tests/log-patterns/events.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

const { bootstrap } = require('../../src/db/schema');
const { recordMatch, findRecent, findForAlertType } = require('../../src/log-patterns/events');
const { loadRegistry } = require('../../src/log-patterns/loader');
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  bootstrap(db);
  return db;
}

function makeRegistry(): any {
  const dir = mkdtempSync(path.join(tmpdir(), 'lpat-evt-'));
  writeFileSync(path.join(dir, 'jellyfin.yaml'),
    `images: ["*jellyfin*"]\ntitle: jelly\npatterns:\n` +
    `  - { id: media_file_corrupted, regex: 'File ended prematurely', severity: warning, explains_alert: [respawn_loop] }\n` +
    `  - { id: ffmpeg_fatal, regex: 'fatal', severity: warning }\n`);
  const reg = loadRegistry(dir);
  rmSync(dir, { recursive: true });
  return reg;
}

function evt(patternId: string, line: string) {
  return {
    patternId, hostId: 'h1', containerName: 'jellyfin', image: 'linuxserver/jellyfin',
    matchedLine: line, contextBefore: ['x'], contextAfter: ['y'],
    captures: {}, lineHash: `${patternId}-${line.slice(0, 8)}`,
  };
}

test('recordMatch inserts a new row on first match', () => {
  const db = freshDb();
  const reg = makeRegistry();
  recordMatch(db, evt('media_file_corrupted', 'File ended prematurely'), reg);
  const row = db.prepare("SELECT pattern_id, occurrences FROM log_pattern_events").get() as any;
  assert.equal(row.pattern_id, 'media_file_corrupted');
  assert.equal(row.occurrences, 1);
});

test('recordMatch upserts on repeat: occurrences bumps, no new row', () => {
  const db = freshDb();
  const reg = makeRegistry();
  recordMatch(db, evt('media_file_corrupted', 'File ended prematurely'), reg);
  recordMatch(db, evt('media_file_corrupted', 'File ended prematurely'), reg);
  recordMatch(db, evt('media_file_corrupted', 'File ended prematurely'), reg);
  const rows = db.prepare("SELECT occurrences FROM log_pattern_events").all() as Array<{ occurrences: number }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].occurrences, 3);
});

test('recordMatch with different line_hash creates a sibling row', () => {
  const db = freshDb();
  const reg = makeRegistry();
  const a = evt('media_file_corrupted', 'File ended prematurely');
  const b = { ...evt('media_file_corrupted', 'Premature end of file'), lineHash: 'differentHash' };
  recordMatch(db, a, reg);
  recordMatch(db, b, reg);
  const count = (db.prepare("SELECT COUNT(*) AS n FROM log_pattern_events").get() as any).n;
  assert.equal(count, 2);
});

test('findRecent returns events within window', () => {
  const db = freshDb();
  const reg = makeRegistry();
  recordMatch(db, evt('media_file_corrupted', 'A'), reg);
  // Backdate one row to outside the window
  db.prepare("UPDATE log_pattern_events SET fired_at = datetime('now', '-2 hours')").run();
  recordMatch(db, { ...evt('media_file_corrupted', 'B'), lineHash: 'h2' }, reg);
  const recent = findRecent(db, 'h1', 'jellyfin', '-30 minutes');
  assert.equal(recent.length, 1);
});

test('findForAlertType returns only events whose pattern explains the alert', () => {
  const db = freshDb();
  const reg = makeRegistry();
  recordMatch(db, evt('media_file_corrupted', 'A'), reg);     // explains respawn_loop
  recordMatch(db, evt('ffmpeg_fatal', 'B'), reg);              // explains nothing
  const hits = findForAlertType(db, 'respawn_loop', 'h1', 'jellyfin', '-1 hour', reg);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].pattern_id, 'media_file_corrupted');
});
```

- [ ] **Step 5.2: Run test, expect FAIL**

```bash
cd /home/andreas/insightd/hub && npx tsx --test tests/log-patterns/events.test.ts
```

- [ ] **Step 5.3: Implement `hub/src/log-patterns/events.ts`**

```ts
import type Database from 'better-sqlite3';
import logger = require('../../../shared/utils/logger');
import type { MatchEvent, Registry } from './types';

function recordMatch(db: Database.Database, ev: MatchEvent, _registry: Registry): void {
  try {
    db.prepare(`
      INSERT INTO log_pattern_events
        (host_id, container_name, image, pattern_id, matched_line,
         context_before, context_after, captures, line_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(host_id, container_name, pattern_id, line_hash)
      DO UPDATE SET
        occurrences = occurrences + 1,
        last_seen_at = datetime('now'),
        captures = excluded.captures
    `).run(
      ev.hostId,
      ev.containerName,
      ev.image,
      ev.patternId,
      ev.matchedLine,
      JSON.stringify(ev.contextBefore ?? []),
      JSON.stringify(ev.contextAfter ?? []),
      JSON.stringify(ev.captures ?? {}),
      ev.lineHash,
    );
  } catch (err) {
    logger.warn('log-patterns', `recordMatch failed for pattern ${ev.patternId}: ${(err as Error).message}`);
  }
}

interface RecentRow {
  id: number;
  host_id: string;
  container_name: string;
  pattern_id: string;
  matched_line: string;
  fired_at: string;
  last_seen_at: string;
  occurrences: number;
  context_before: string | null;
  context_after: string | null;
  captures: string | null;
}

function findRecent(
  db: Database.Database,
  hostId: string,
  containerName: string,
  sinceRelative: string, // e.g. '-15 minutes'
  patternIds?: string[],
): RecentRow[] {
  if (patternIds && patternIds.length > 0) {
    const placeholders = patternIds.map(() => '?').join(',');
    return db.prepare(`
      SELECT id, host_id, container_name, pattern_id, matched_line, fired_at, last_seen_at, occurrences, context_before, context_after, captures
        FROM log_pattern_events
       WHERE host_id = ? AND container_name = ?
         AND fired_at >= datetime('now', ?)
         AND pattern_id IN (${placeholders})
       ORDER BY fired_at DESC
    `).all(hostId, containerName, sinceRelative, ...patternIds) as RecentRow[];
  }
  return db.prepare(`
    SELECT id, host_id, container_name, pattern_id, matched_line, fired_at, last_seen_at, occurrences, context_before, context_after, captures
      FROM log_pattern_events
     WHERE host_id = ? AND container_name = ?
       AND fired_at >= datetime('now', ?)
     ORDER BY fired_at DESC
  `).all(hostId, containerName, sinceRelative) as RecentRow[];
}

function findForAlertType(
  db: Database.Database,
  alertType: string,
  hostId: string,
  containerName: string,
  sinceRelative: string,
  registry: Registry,
): RecentRow[] {
  const matchingPatternIds = registry.all
    .filter(p => p.explainsAlert.includes(alertType))
    .map(p => p.id);
  if (matchingPatternIds.length === 0) return [];
  return findRecent(db, hostId, containerName, sinceRelative, matchingPatternIds);
}

module.exports = { recordMatch, findRecent, findForAlertType };
```

- [ ] **Step 5.4: Run test, expect PASS**

```bash
cd /home/andreas/insightd/hub && npx tsx --test tests/log-patterns/events.test.ts 2>&1 | tail -10
```
Expected: 5 pass.

- [ ] **Step 5.5: Commit**

```bash
cd /home/andreas/insightd
git add hub/src/log-patterns/events.ts hub/tests/log-patterns/events.test.ts
git commit -m "feat(log-patterns): events DB module — UPSERT + lookup (#263)"
```

---

## Task 6: Wire matcher into `logCache.writeLogs`

**Files:**
- Modify: `hub/src/insights/diagnosis/logCache.ts`
- Modify: `hub/src/log-patterns/types.ts` (if needed — confirm `Registry` is exported)

- [ ] **Step 6.1: Find the public write entry**

```bash
grep -n "export function write\|module.exports\|function writeLogs\|function cacheLogs" /home/andreas/insightd/hub/src/insights/diagnosis/logCache.ts | head -10
```

The two candidates are around lines 372 and 406 (the `ctx?: LogCacheContext` signatures). Identify the public write function — the one that takes a list of log lines and writes them into the cache, accepting `ctx?: LogCacheContext`.

- [ ] **Step 6.2: Add the registry singleton accessor**

Create a tiny module to hold the registry singleton so logCache doesn't depend on application-wide config. Add at the top of `hub/src/log-patterns/index.ts` (NEW file):

```ts
import type { Registry } from './types';
const { loadRegistry } = require('./loader');

let cached: Registry | null = null;

function getRegistry(rootDir: string): Registry {
  if (cached) return cached;
  cached = loadRegistry(rootDir);
  return cached;
}

function resetRegistryForTest(): void {
  cached = null;
}

module.exports = { getRegistry, resetRegistryForTest };
```

- [ ] **Step 6.3: Wire matcher + events into logCache write**

In `hub/src/insights/diagnosis/logCache.ts`:

Add near the top, alongside existing requires:
```ts
const { matchLines } = require('../../log-patterns/matcher');
const { recordMatch } = require('../../log-patterns/events');
const { getRegistry } = require('../../log-patterns');
```

Import config to get the registry dir (look for how other files import config — likely `require('../../config')`):
```ts
const { config } = require('../../config') as { config: { logPatterns: { enabled: boolean; dir: string } } };
```

Inside the function that writes logs (around line 372 / 406), after the `mineTemplates(...)` call and the template_burst persistence block, append (only if `ctx` is provided — we need `db` + `image`):

```ts
if (ctx && config.logPatterns?.enabled !== false) {
  try {
    const registry = getRegistry(config.logPatterns?.dir ?? 'shared/log-patterns');
    if (registry.all.length > 0 && scope) {
      const events = matchLines(
        lines.map(l => l.message ?? ''),
        ctx.image,
        scope.hostId,
        scope.containerName,
        registry,
      );
      for (const ev of events) recordMatch(ctx.db, ev, registry);
    }
  } catch (err) {
    // Matcher failures must never break the cache write path
    const logger = require('../../../../shared/utils/logger');
    logger.warn('log-patterns', `logCache match step failed: ${(err as Error).message}`);
  }
}
```

(`scope` is the existing `{ hostId, containerName }` parameter on the write function — verify the name matches your file's local symbol.)

- [ ] **Step 6.4: Typecheck**

```bash
cd /home/andreas/insightd/hub && npx tsc --noEmit 2>&1 | tail -5
```

If config typing complains because `config.logPatterns` is not declared yet — Task 12 adds the config block. For now, use a defensive optional chain (`config.logPatterns?.enabled !== false`) and cast at the require site as shown.

- [ ] **Step 6.5: Run the full hub test suite (sanity)**

```bash
cd /home/andreas/insightd && npm test 2>&1 | tail -10
```
Expected: no regression. (Existing logCache tests still pass — the new hook gates on registry being non-empty which the default empty registry guarantees on test boot.)

- [ ] **Step 6.6: Commit**

```bash
cd /home/andreas/insightd
git add hub/src/log-patterns/index.ts hub/src/insights/diagnosis/logCache.ts
git commit -m "feat(log-patterns): hook matcher into logCache write path (#263)"
```

---

## Task 7: Materialize `log_pattern_match` insights

**Files:**
- Modify: `hub/src/insights/detector.ts`

- [ ] **Step 7.1: Locate the end of `generateInsights`**

```bash
grep -n "function generateInsights\|--- Process respawn" /home/andreas/insightd/hub/src/insights/detector.ts | head -5
```

You'll insert the new block BEFORE the existing `// --- Process respawn-loop insights ---` block (so log patterns materialize before respawn), or after it (cosmetic). Pick whichever keeps both blocks together at the end.

- [ ] **Step 7.2: Append the materialization block**

In `hub/src/insights/detector.ts`, near the end of `generateInsights`, add:

```ts
  // --- Log-pattern match insights ---
  // Each (host, container, pattern_id) materializes one insight using the most
  // recent event's evidence + cumulative occurrences over the last 24h.
  const logPatternRows = db.prepare(`
    SELECT host_id, container_name, image, pattern_id,
           MAX(fired_at) AS latest_at,
           SUM(occurrences) AS total_occ
      FROM log_pattern_events
     WHERE fired_at >= datetime('now', '-24 hours')
     GROUP BY host_id, container_name, pattern_id
  `).all() as Array<{ host_id: string; container_name: string; image: string | null; pattern_id: string; latest_at: string; total_occ: number }>;

  for (const r of logPatternRows) {
    const latest = db.prepare(`
      SELECT matched_line, context_before, context_after, captures, fired_at
        FROM log_pattern_events
       WHERE host_id = ? AND container_name = ? AND pattern_id = ?
       ORDER BY fired_at DESC
       LIMIT 1
    `).get(r.host_id, r.container_name, r.pattern_id) as
      { matched_line: string; context_before: string | null; context_after: string | null; captures: string | null; fired_at: string } | undefined;
    if (!latest) continue;

    const evidence = JSON.stringify({
      pattern_id: r.pattern_id,
      image: r.image,
      matched_line: latest.matched_line,
      context_before: latest.context_before ? JSON.parse(latest.context_before) : [],
      context_after:  latest.context_after  ? JSON.parse(latest.context_after)  : [],
      captures:       latest.captures       ? JSON.parse(latest.captures)       : {},
      fired_at: latest.fired_at,
      occurrences: r.total_occ,
    });

    insert.run(
      'container',
      `${r.host_id}/${r.container_name}`,
      'logs',
      'warning',   // severity defaulting; per-pattern severity overlay in a follow-up
      `Log pattern: ${r.pattern_id}`,
      `Matched ${r.total_occ}× in last 24h.`,
      'log_pattern_match',
      r.total_occ,
      null,
      evidence,
    );
    count++;
  }
```

(Match the existing `insert.run(...)` 10-arg signature exactly — same columns as the respawn-loop block.)

- [ ] **Step 7.3: Typecheck + full suite**

```bash
cd /home/andreas/insightd/hub && npx tsc --noEmit 2>&1 | tail -5
cd /home/andreas/insightd && npm test 2>&1 | tail -10
```

- [ ] **Step 7.4: Commit**

```bash
cd /home/andreas/insightd
git add hub/src/insights/detector.ts
git commit -m "feat(insights): materialize log_pattern_match insights (#263)"
```

---

## Task 8: Stamp `alert_state.explained_by_pattern_event_id` in `processAlerts`

**Files:**
- Modify: `hub/src/alerts/evaluator.ts`

- [ ] **Step 8.1: Find the alert_state INSERT sites**

```bash
grep -n "INSERT INTO alert_state" /home/andreas/insightd/hub/src/alerts/evaluator.ts | head -5
```

You'll find two INSERT sites (around lines 1451 and 1480). Both happen inside `processAlerts`. We want to stamp `explained_by_pattern_event_id` immediately after either INSERT lands a row.

- [ ] **Step 8.2: Add the require + helper near top of evaluator.ts**

Add to the require list near the top (next to `findActiveRespawnLoops`):
```ts
const { findForAlertType } = require('../log-patterns/events');
const { getRegistry } = require('../log-patterns');
```

Below the imports, add a tiny helper (place above `evaluateAlerts` or near the other small helpers):
```ts
function stampExplanation(db: Database.Database, alertStateId: number, alert: AlertItem): void {
  const config = require('../config').config as { logPatterns?: { enabled?: boolean; dir?: string } };
  if (config.logPatterns?.enabled === false) return;
  try {
    const registry = getRegistry(config.logPatterns?.dir ?? 'shared/log-patterns');
    const hits = findForAlertType(db, alert.type, alert.hostId, alert.target, '-15 minutes', registry);
    if (hits.length === 0) return;
    db.prepare(
      'UPDATE alert_state SET explained_by_pattern_event_id = ? WHERE id = ? AND explained_by_pattern_event_id IS NULL'
    ).run(hits[0].id, alertStateId);
  } catch {
    // Log-pattern enrichment must never break alert flow
  }
}
```

- [ ] **Step 8.3: Call `stampExplanation` after each alert_state INSERT**

At each INSERT site, capture the new row's id and call the helper. Example for the first site (around line 1451 — `INSERT INTO alert_state (host_id, alert_type, target, ..., trigger_value, threshold)`):

Before the edit, the block looks roughly like:
```ts
const info = db.prepare(`INSERT INTO alert_state (...) VALUES (...)`).run(...);
```

After:
```ts
const info = db.prepare(`INSERT INTO alert_state (...) VALUES (...)`).run(...);
stampExplanation(db, Number(info.lastInsertRowid), alert);
```

Apply to both INSERT sites. If a site already binds to a named variable (e.g. `parentRow = { id: ... }`), reuse the existing id.

- [ ] **Step 8.4: Typecheck + run full suite + the integration test from Task 9 of PR #275 to confirm no regression**

```bash
cd /home/andreas/insightd/hub && npx tsc --noEmit 2>&1 | tail -5
cd /home/andreas/insightd && npm test 2>&1 | tail -10
cd /home/andreas/insightd/hub && npx tsx --test tests/integration/respawn-loop-pipeline.test.ts 2>&1 | tail -5
```
Expected: all green.

- [ ] **Step 8.5: Commit**

```bash
cd /home/andreas/insightd
git add hub/src/alerts/evaluator.ts
git commit -m "feat(alerts): stamp explained_by_pattern_event_id on new alerts (#263)"
```

---

## Task 9: Explain extras block (`log_match`) backend

**Files:**
- Modify: `hub/src/insights/explain.ts`
- Modify: `hub/src/insights/explain-types.ts`

- [ ] **Step 9.1: Extend explain-types.ts**

Add to `hub/src/insights/explain-types.ts` (alongside the existing `TopArgvsBlock` from PR #275):

```ts
export interface LogMatchBlock {
  kind: 'log_match';
  pattern_id: string;
  image: string | null;
  matched_line: string;
  context_before: string[];
  context_after: string[];
  captures: Record<string, string>;
  occurrences: number;
  fired_at: string;
}
```

Then extend the `ExtraBlock` union:

```ts
export type ExtraBlock = TopArgvsBlock | LogMatchBlock;
```

- [ ] **Step 9.2: Wire dispatch in explain.ts**

In `hub/src/insights/explain.ts`, locate the `buildExtras` function added by PR #275. Extend it:

```ts
function buildExtras(insight: InsightRow): ExtraBlock[] | undefined {
  const extras: ExtraBlock[] = [];

  // top_argvs (from PR #275)
  if (insight.metric === 'process_spawn_count') {
    try {
      const ev = insight.evidence ? JSON.parse(insight.evidence) : null;
      const rows = ev?.top_argvs;
      if (Array.isArray(rows) && rows.length > 0) {
        extras.push({ kind: 'top_argvs', rows });
      }
    } catch { /* malformed evidence — skip */ }
  }

  // log_match (NEW)
  if (insight.metric === 'log_pattern_match') {
    try {
      const ev = insight.evidence ? JSON.parse(insight.evidence) : null;
      if (ev && ev.matched_line) {
        extras.push({
          kind: 'log_match',
          pattern_id: ev.pattern_id ?? '',
          image: ev.image ?? null,
          matched_line: ev.matched_line,
          context_before: Array.isArray(ev.context_before) ? ev.context_before : [],
          context_after:  Array.isArray(ev.context_after)  ? ev.context_after  : [],
          captures:       (ev.captures && typeof ev.captures === 'object') ? ev.captures : {},
          occurrences:    typeof ev.occurrences === 'number' ? ev.occurrences : 1,
          fired_at:       ev.fired_at ?? '',
        });
      }
    } catch { /* malformed evidence — skip */ }
  }

  return extras.length ? extras : undefined;
}
```

The local `ExtraBlock` / `LogMatchBlock` type declarations inside `explain.ts` follow the same pattern as the existing `TopArgvsBlock` declarations there.

- [ ] **Step 9.3: Typecheck**

```bash
cd /home/andreas/insightd/hub && npx tsc --noEmit 2>&1 | tail -5
```

- [ ] **Step 9.4: Commit**

```bash
cd /home/andreas/insightd
git add hub/src/insights/explain.ts hub/src/insights/explain-types.ts
git commit -m "feat(insights): log_match explain extras block (#263)"
```

---

## Task 10: Frontend — `LogMatchBlock` + ExpandedBody dispatch + types mirror

**Files:**
- Modify: `hub/src/web/frontend/src/types/api.ts`
- Create: `hub/src/web/frontend/src/components/insights/LogMatchBlock.tsx`
- Modify: `hub/src/web/frontend/src/components/insights/ExpandedBody.tsx`

- [ ] **Step 10.1: Mirror types in api.ts**

Add (next to `ExplainTopArgvsBlock` from PR #275):

```ts
export interface ExplainLogMatchBlock {
  kind: 'log_match';
  pattern_id: string;
  image: string | null;
  matched_line: string;
  context_before: string[];
  context_after: string[];
  captures: Record<string, string>;
  occurrences: number;
  fired_at: string;
}
```

Extend the `ExplainExtraBlock` union:

```ts
export type ExplainExtraBlock = ExplainTopArgvsBlock | ExplainLogMatchBlock;
```

- [ ] **Step 10.2: Create the component**

Create `hub/src/web/frontend/src/components/insights/LogMatchBlock.tsx`:

```tsx
import type { ExplainLogMatchBlock } from '@/types/api';

export function LogMatchBlock(props: ExplainLogMatchBlock) {
  const { pattern_id, matched_line, context_before, context_after, captures, occurrences } = props;
  const captureRows = Object.entries(captures);
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <div className="flex items-center justify-between bg-bg-secondary px-3 py-2 text-xs">
        <span className="font-medium uppercase tracking-wide text-muted">{pattern_id}</span>
        <span className="tabular-nums text-muted">{occurrences}× in last 24h</span>
      </div>
      <pre className="bg-bg px-3 py-2 text-xs overflow-x-auto font-mono whitespace-pre">
        {context_before.length > 0 && (
          <span className="text-muted">{context_before.join('\n')}{'\n'}</span>
        )}
        <span className="text-fg font-medium">{matched_line}</span>
        {context_after.length > 0 && (
          <span className="text-muted">{'\n'}{context_after.join('\n')}</span>
        )}
      </pre>
      {captureRows.length > 0 && (
        <table className="w-full text-sm">
          <thead className="text-xs text-muted">
            <tr>
              <th scope="col" className="px-3 py-1.5 text-left">Field</th>
              <th scope="col" className="px-3 py-1.5 text-left">Value</th>
            </tr>
          </thead>
          <tbody>
            {captureRows.map(([k, v]) => (
              <tr key={k} className="border-t border-border">
                <td className="px-3 py-1.5 font-mono">{k}</td>
                <td className="px-3 py-1.5 font-mono break-all">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

- [ ] **Step 10.3: Dispatch in ExpandedBody.tsx**

Open `hub/src/web/frontend/src/components/insights/ExpandedBody.tsx`. Locate the extras map block (from PR #275, currently dispatches `'top_argvs'`). Extend:

```tsx
import { LogMatchBlock } from './LogMatchBlock';

// ... inside the render ...

{explain.extras?.map((block, i) => {
  if (block.kind === 'top_argvs') return <TopArgvsTable key={`${block.kind}-${i}`} {...block} />;
  if (block.kind === 'log_match') return <LogMatchBlock key={`${block.kind}-${i}`} {...block} />;
  return null;
})}
```

- [ ] **Step 10.4: Frontend typecheck + build**

```bash
cd /home/andreas/insightd/hub/src/web/frontend && npx tsc --noEmit 2>&1 | tail -5
cd /home/andreas/insightd/hub/src/web/frontend && npm run build 2>&1 | tail -5
```

- [ ] **Step 10.5: Commit**

```bash
cd /home/andreas/insightd
git add hub/src/web/frontend/src/types/api.ts hub/src/web/frontend/src/components/insights/LogMatchBlock.tsx hub/src/web/frontend/src/components/insights/ExpandedBody.tsx
git commit -m "feat(ui): log_match extras block in insight explain (#263)"
```

---

## Task 11: Frontend — "↳ likely cause" chip on alert rows

**Files:**
- Modify: alert-row-rendering component under `hub/src/web/frontend/src/pages/alerts/`
- Modify: alert API types in `hub/src/web/frontend/src/types/api.ts`
- Modify: the API handler that returns alerts so it includes `explained_by_pattern_event_id`

- [ ] **Step 11.1: Find the alerts list component**

```bash
grep -rn "alert_type\|AlertRow\|AlertCard\|explained_by\|suppressed_by_state_id" /home/andreas/insightd/hub/src/web/frontend/src/pages/alerts --include='*.tsx' -l
```

Identify the file that renders one alert row (likely `AlertsPage.tsx` or a sibling `AlertRow.tsx`). Read it to understand existing field threading.

- [ ] **Step 11.2: Thread `explained_by_pattern_event_id` from API**

Find the backend handler that returns alerts (likely `hub/src/web/handlers/alerts.ts` or similar):

```bash
grep -rn "alert_state\|SELECT.*alert_state\|/api/alerts" /home/andreas/insightd/hub/src/web --include='*.ts' -l | head -5
```

In the SELECT query that returns alerts, add `explained_by_pattern_event_id` to the column list (next to `suppressed_by_state_id`).

In the API type for alert rows in `hub/src/web/frontend/src/types/api.ts`, add the optional field:

```ts
export interface AlertRow {
  // ... existing fields ...
  explained_by_pattern_event_id: number | null;
}
```

(Adapt to the existing interface name — likely `AlertItem` or `AlertState`.)

- [ ] **Step 11.3: Add a fetch endpoint or join to resolve the pattern title**

Two options — pick the smaller one:

(a) **Lazy: render `pattern_id` directly.** In the alert row component, when `explained_by_pattern_event_id` is non-null, fetch a tiny endpoint `/api/log-patterns/event/:id` returning `{ pattern_id, pattern_title, matched_line }`. Implement this endpoint in the same alert-handler file or a new file.

(b) **Eager: JOIN at SELECT time.** Modify the alerts SELECT to LEFT JOIN log_pattern_events and include `lpe_pattern_id`, `lpe_matched_line` directly in the row. Saves a request per alert.

Recommend (b) for simplicity. Add to the SELECT:
```sql
LEFT JOIN log_pattern_events lpe ON lpe.id = alert_state.explained_by_pattern_event_id
```
And select `lpe.pattern_id AS explained_pattern_id`, `lpe.matched_line AS explained_line`.

Add fields to the API type:
```ts
explained_pattern_id: string | null;
explained_line: string | null;
```

- [ ] **Step 11.4: Render the chip**

In the alert row component, alongside existing severity/status chips, conditional render:

```tsx
{alert.explained_pattern_id && (
  <span className="inline-flex items-center gap-1 rounded-full bg-bg-secondary px-2 py-0.5 text-xs text-muted">
    ↳ likely cause: <span className="font-mono">{alert.explained_pattern_id}</span>
  </span>
)}
```

- [ ] **Step 11.5: Typecheck + build**

```bash
cd /home/andreas/insightd/hub && npx tsc --noEmit 2>&1 | tail -5
cd /home/andreas/insightd/hub/src/web/frontend && npx tsc --noEmit 2>&1 | tail -5
cd /home/andreas/insightd/hub/src/web/frontend && npm run build 2>&1 | tail -5
```

- [ ] **Step 11.6: Commit**

```bash
cd /home/andreas/insightd
git add hub/src/web hub/src/web/frontend
git commit -m "feat(ui): likely-cause chip on alert rows (#263)"
```

(If the API handler lives outside `hub/src/web`, adjust the `git add` accordingly.)

---

## Task 12: Config env knobs

**Files:**
- Modify: `hub/src/config.ts`
- Modify: `CLAUDE.md`

- [ ] **Step 12.1: Find where the alerts block ends**

```bash
grep -n "respawnShortLifetimeRatio\|alerts: Object.freeze" /home/andreas/insightd/hub/src/config.ts | head -5
```

- [ ] **Step 12.2: Add a `logPatterns` block AFTER the `alerts` block, before the closing brace of the frozen config object**

```ts
  logPatterns: Object.freeze({
    enabled: process.env.INSIGHTD_LOG_PATTERNS_ENABLED !== 'false',
    dir: process.env.INSIGHTD_LOG_PATTERNS_DIR || 'shared/log-patterns',
    retentionDays: parseInt(process.env.INSIGHTD_LOG_PATTERN_RETENTION_DAYS || '7', 10),
  }),
```

- [ ] **Step 12.3: Wire retention into pruneOldData**

In `hub/src/db/schema.ts`, locate the existing `DELETE FROM log_pattern_events WHERE fired_at < datetime('now', '-7 days')` from Task 4. If `pruneOldData` accepts a retention parameter, plumb `config.logPatterns.retentionDays` through (look at how `rawDays` is passed). Otherwise, inline the env read:

```ts
const lpRetention = parseInt(process.env.INSIGHTD_LOG_PATTERN_RETENTION_DAYS || '7', 10);
db.prepare(`DELETE FROM log_pattern_events WHERE fired_at < datetime('now', '-${lpRetention} days')`).run();
```
(Note: `${lpRetention}` is inlined into the SQL string after parseInt — safe because we sanitize via parseInt.)

- [ ] **Step 12.4: Update CLAUDE.md**

Add to `## Key Environment Variables`:

```
- `INSIGHTD_LOG_PATTERNS_ENABLED` / `INSIGHTD_LOG_PATTERNS_DIR` / `INSIGHTD_LOG_PATTERN_RETENTION_DAYS` — log-pattern framework (default: on / shared/log-patterns / 7)
```

- [ ] **Step 12.5: Typecheck**

```bash
cd /home/andreas/insightd/hub && npx tsc --noEmit 2>&1 | tail -5
```

- [ ] **Step 12.6: Commit**

```bash
cd /home/andreas/insightd
git add hub/src/config.ts hub/src/db/schema.ts CLAUDE.md
git commit -m "feat(config): log-pattern env knobs + retention plumbing (#263)"
```

---

## Task 13: Ship `jellyfin.yaml` + `CONTRIBUTING.md`

**Files:**
- Create: `shared/log-patterns/jellyfin.yaml`
- Create: `shared/log-patterns/CONTRIBUTING.md`

- [ ] **Step 13.1: Create the directory + file**

```bash
mkdir -p /home/andreas/insightd/shared/log-patterns
```

Write `shared/log-patterns/jellyfin.yaml`:

```yaml
images:
  - "*jellyfin*"
title: "Jellyfin"
patterns:
  - id: media_file_corrupted
    title: "Media file ended prematurely"
    description: >
      ffmpeg or libavformat reports the input file ended before the declared
      duration. Usually means a truncated source (incomplete download, broken
      transfer) or misreported metadata duration. Jellyfin retries on every
      playback, causing visible respawn loops.
    regex: 'File ended prematurely|Premature end of (?:file|stream)'
    severity: warning
    insight_category: logs
    explains_alert:
      - respawn_loop
      - container_unhealthy

  - id: ffmpeg_fatal
    title: "FFmpeg fatal error"
    description: "Unrecoverable ffmpeg error during transcode."
    regex: '\[fatal\]\s+(?<message>.+)'
    captures:
      - message
    severity: warning
    insight_category: logs
    explains_alert:
      - respawn_loop

  - id: transcode_timeout
    title: "Transcode segment timeout"
    description: "Jellyfin transcoder dropped a segment after waiting too long."
    regex: 'Transcode segment .*? timed out after (?<seconds>\d+) seconds'
    captures:
      - seconds
    severity: warning
    insight_category: logs
```

- [ ] **Step 13.2: Write `shared/log-patterns/CONTRIBUTING.md`**

```markdown
# Contributing log patterns

The hub loads every `*.yaml` file in this directory at boot and matches the patterns against logs already cached for each container.

## File layout

One file per upstream image, named so it's easy to find: `<image>.yaml`. Patterns inside the file can cover multiple variants of the same upstream (e.g. `jellyfin/jellyfin` and `linuxserver/jellyfin`) via the `images:` glob array.

## Schema

```yaml
images: ["*jellyfin*"]    # required, ≥1 entry. `*foo*` substring, `foo*` prefix, `*foo` suffix, `foo` exact.
title: "Jellyfin"         # optional, file label.
patterns:                  # required.
  - id: short-kebab-case-id          # required, globally unique across all files.
    title: "Human-readable"           # optional, defaults to id.
    description: "Why this matters"   # optional.
    regex: 'literal|or alternation'   # required, JavaScript-flavor regex.
    captures: [name]                  # optional named groups; loader validates they're present in the regex.
    severity: warning                 # info | warning | critical. Default warning.
    insight_category: logs            # default 'logs'.
    explains_alert: [respawn_loop]    # optional; stamps the listed alerts.
```

## Acceptance criteria

- The pattern names a SPECIFIC pathology with a clear, image-specific signature. Generic patterns belong in the hub's hardcoded `templateClassifier.ts`.
- The PR includes the original log line in the description or a linked incident.
- Regex hygiene:
  - Anchor where possible (`^`, line markers).
  - Prefer literal substrings as the anchor + lookaheads/alternation for variants.
  - Avoid nested quantifiers (`(\w+)+`) and other ReDoS shapes. The loader pre-compiles regexes but does not perform ReDoS analysis.
  - One pattern per pathology — multiple regexes for the same root cause should be combined with `|` alternation.
- `explains_alert:` only when the matched line genuinely implies the listed alert's root cause for the same container.

## Limitations (read first)

- Stdout/stderr only. Patterns that target log files inside the container (linuxserver's `/config/log/FFmpeg.*.log`, postgres's per-DB logs, etc.) will not fire until container-internal log tailing lands.
- Patterns run only when the hub has fetched logs for a container — currently on unhealthy transition, container-detail page load, or manual diagnose. They do not run continuously.
- Pattern reload requires a hub restart.
```

- [ ] **Step 13.3: Confirm the loader picks up the file at boot**

```bash
cd /home/andreas/insightd/hub && npx tsx -e "const {loadRegistry}=require('./src/log-patterns/loader'); const r=loadRegistry('../shared/log-patterns'); console.log(r.all.map(p=>p.id))"
```
Expected: `[ 'media_file_corrupted', 'ffmpeg_fatal', 'transcode_timeout' ]`

- [ ] **Step 13.4: Commit**

```bash
cd /home/andreas/insightd
git add shared/log-patterns/jellyfin.yaml shared/log-patterns/CONTRIBUTING.md
git commit -m "feat(log-patterns): jellyfin.yaml + CONTRIBUTING.md (#263)"
```

---

## Task 14: Pipeline integration test

**Files:**
- Create: `hub/tests/integration/log-patterns-pipeline.test.ts`

- [ ] **Step 14.1: Inspect public signatures**

```bash
grep -n "module.exports = { generateInsights" /home/andreas/insightd/hub/src/insights/detector.ts
grep -n "module.exports = { evaluateAlerts, processAlerts" /home/andreas/insightd/hub/src/alerts/evaluator.ts
grep -n "export function\|module.exports" /home/andreas/insightd/hub/src/insights/diagnosis/logCache.ts | head -10
```

Note: the test can call `logCache`'s write function directly OR insert log_pattern_events rows directly. Direct DB seeding is simpler for an integration test (decouples from logCache internals).

- [ ] **Step 14.2: Write the test**

Create `hub/tests/integration/log-patterns-pipeline.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { bootstrap } = require('../../src/db/schema');
const { generateInsights } = require('../../src/insights/detector');
const { evaluateAlerts, processAlerts } = require('../../src/alerts/evaluator');
const { buildExplanation } = require('../../src/insights/explain');
const { loadRegistry } = require('../../src/log-patterns/loader');
const { recordMatch } = require('../../src/log-patterns/events');
const { resetRegistryForTest } = require('../../src/log-patterns');

function writeRegistry(): { dir: string; registry: any } {
  const dir = mkdtempSync(path.join(tmpdir(), 'lpat-int-'));
  writeFileSync(path.join(dir, 'jellyfin.yaml'),
    `images: ["*jellyfin*"]\ntitle: jelly\npatterns:\n` +
    `  - { id: media_file_corrupted, regex: 'File ended prematurely', severity: warning, explains_alert: [respawn_loop] }\n`);
  const registry = loadRegistry(dir);
  return { dir, registry };
}

function setup(): { db: Database.Database; cleanup: () => void; registry: any } {
  resetRegistryForTest();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  bootstrap(db);

  db.prepare(`INSERT INTO hosts (host_id) VALUES ('h1')`).run();
  db.prepare(`
    INSERT INTO container_snapshots (host_id, container_id, container_name, status, collected_at, cpu_percent, memory_mb, image)
    VALUES ('h1', 'c1', 'jellyfin', 'running', datetime('now'), 50, 800, 'linuxserver/jellyfin:latest')
  `).run();
  db.prepare(`INSERT INTO containers (host_id, container_id, container_name) VALUES ('h1','c1','jellyfin')`).run();

  const { dir, registry } = writeRegistry();
  // Override config singleton: point getRegistry at our temp dir
  process.env.INSIGHTD_LOG_PATTERNS_DIR = dir;

  return { db, cleanup: () => { rmSync(dir, { recursive: true }); resetRegistryForTest(); }, registry };
}

const baseAlertsConfig = {
  enabled: true, to: 'test@example.com', cooldownMinutes: 60,
  cpuPercent: 80, memoryMb: 0, diskPercent: 90, restartCount: 3,
  containerDown: true,
  hostCpuPercent: 90, hostMemoryAvailableMb: 0, hostLoadThreshold: 0,
  hostOffline: false, hostOfflineMinutes: 15,
  containerUnhealthy: false, imagePullFailure: false, excludeContainers: '',
  endpointDown: false, endpointFailureThreshold: 3,
  containerMemoryLimitPercent: 0, containerCpuLimitPercent: 0,
  flapStabilizeMinutes: 0, diskCriticalPercent: 95,
  mailCriticalOnly: true, suppressDependents: true,
  respawnLoop: false,
};
const evalConfig = (): any => ({ alerts: baseAlertsConfig, smtp: { host: '', port: 0, user: '', pass: '', from: '' } });

test('log-pattern match → insight materialized with log_match extras', () => {
  const { db, cleanup, registry } = setup();
  try {
    recordMatch(db, {
      patternId: 'media_file_corrupted',
      hostId: 'h1',
      containerName: 'jellyfin',
      image: 'linuxserver/jellyfin',
      matchedLine: '[matroska,webm @ 0x...] File ended prematurely',
      contextBefore: ['decode start'],
      contextAfter: ['exit code 1'],
      captures: {},
      lineHash: 'h-1',
    }, registry);

    generateInsights(db);

    const insight = db.prepare(
      "SELECT id, evidence FROM insights WHERE metric = 'log_pattern_match'"
    ).get() as { id: number; evidence: string } | undefined;
    assert.ok(insight, 'expected log_pattern_match insight row');
    const ev = JSON.parse(insight.evidence);
    assert.equal(ev.pattern_id, 'media_file_corrupted');
    assert.equal(ev.occurrences, 1);

    const insightRow = db.prepare('SELECT * FROM insights WHERE id = ?').get(insight.id);
    const explanation = buildExplanation(db, insightRow);
    assert.ok(Array.isArray(explanation.extras));
    const lm = explanation.extras.find((b: any) => b.kind === 'log_match');
    assert.ok(lm, 'expected log_match extras block');
    assert.equal(lm.pattern_id, 'media_file_corrupted');
    assert.equal(lm.matched_line, '[matroska,webm @ 0x...] File ended prematurely');
  } finally { cleanup(); }
});

test('alert stamping: new respawn_loop gets explained_by_pattern_event_id when matching log event exists', () => {
  const { db, cleanup, registry } = setup();
  try {
    recordMatch(db, {
      patternId: 'media_file_corrupted',
      hostId: 'h1', containerName: 'jellyfin', image: 'linuxserver/jellyfin',
      matchedLine: 'File ended prematurely',
      contextBefore: [], contextAfter: [], captures: {}, lineHash: 'h-2',
    }, registry);
    const evRow = db.prepare("SELECT id FROM log_pattern_events").get() as { id: number };

    // Seed a fake triggered AlertItem and run processAlerts
    const triggered = [{
      type: 'respawn_loop', hostId: 'h1', target: 'jellyfin',
      message: 'respawn loop', value: 25, threshold: 20,
    }];
    processAlerts(db, evalConfig(), { triggered, resolved: [] });

    const alert = db.prepare(
      `SELECT id, explained_by_pattern_event_id FROM alert_state WHERE alert_type = 'respawn_loop' AND target = 'jellyfin'`
    ).get() as { id: number; explained_by_pattern_event_id: number | null };
    assert.ok(alert, 'expected alert_state row');
    assert.equal(alert.explained_by_pattern_event_id, evRow.id,
      'alert should be stamped with the matching log_pattern_event id');
  } finally { cleanup(); }
});

test('alert stamping: no log event → no stamp', () => {
  const { db, cleanup } = setup();
  try {
    const triggered = [{
      type: 'respawn_loop', hostId: 'h1', target: 'jellyfin',
      message: 'respawn loop', value: 25, threshold: 20,
    }];
    processAlerts(db, evalConfig(), { triggered, resolved: [] });
    const alert = db.prepare(
      `SELECT explained_by_pattern_event_id FROM alert_state WHERE alert_type = 'respawn_loop'`
    ).get() as { explained_by_pattern_event_id: number | null };
    assert.equal(alert.explained_by_pattern_event_id, null);
  } finally { cleanup(); }
});
```

- [ ] **Step 14.3: Run the test**

```bash
cd /home/andreas/insightd/hub && npx tsx --test tests/integration/log-patterns-pipeline.test.ts 2>&1 | tail -10
```

If the alert stamping test fails because `processAlerts` doesn't reach `stampExplanation` for the test's config shape, debug the path: confirm `config.logPatterns` is present (Task 12) and not gating to disabled, and confirm `INSIGHTD_LOG_PATTERNS_DIR` is honored by `getRegistry`.

- [ ] **Step 14.4: Run the full root suite**

```bash
cd /home/andreas/insightd && npm test 2>&1 | tail -10
```

- [ ] **Step 14.5: Commit**

```bash
cd /home/andreas/insightd
git add hub/tests/integration/log-patterns-pipeline.test.ts
git commit -m "test(integration): log-pattern pipeline + alert stamping (#263)"
```

---

## Task 15: Validate + PR + memory

- [ ] **Step 15.1: Full validation matrix**

```bash
cd /home/andreas/insightd && npm test 2>&1 | tail -10
cd /home/andreas/insightd/hub && npx tsc --noEmit 2>&1 | tail -5
cd /home/andreas/insightd/hub/src/web/frontend && npx tsc --noEmit 2>&1 | tail -5
cd /home/andreas/insightd/hub/src/web/frontend && npm run build 2>&1 | tail -5
```
Expected: all clean.

- [ ] **Step 15.2: Manual on vdev**

Deploy current branch to vdev. SSH to a Jellyfin host, play a deliberately-truncated mkv to trigger `File ended prematurely`. Verify:
- `log_pattern_events` table has a row.
- Insights tab on the container shows `Log pattern: media_file_corrupted` insight.
- Expanding shows `LogMatchBlock` with the matched line in monospace, context lines, no captures (this pattern declares none).
- If `respawn_loop` (PR #275) fires concurrently, its row shows the "↳ likely cause: media_file_corrupted" chip.

- [ ] **Step 15.3: Push + open PR**

```bash
git push -u origin feat/log-pattern-framework
gh pr create --title "Log-pattern framework + Jellyfin pattern (#263)" --body "$(cat <<'EOF'
## Summary
- YAML-driven log-pattern matching framework. Patterns live in `shared/log-patterns/<image>.yaml`.
- Matches run hub-side on log batches already in `logCache` — no new bandwidth, no agent changes.
- Each match surfaces as a standalone insight (`category=logs`, `metric=log_pattern_match`) AND stamps related alerts via new `alert_state.explained_by_pattern_event_id`.
- Schema v54 adds `log_pattern_events` table (UPSERT-on-repeat) + the alert_state column. Retention 7 days, runs under existing 03:30 prune cron.
- Ships `jellyfin.yaml` (field-validated against the May 2026 truncated-mkv case) + `CONTRIBUTING.md` inviting community pattern PRs.
- Stdout/stderr only. Container-internal log file tailing deferred to a follow-up.

## Architecture
- `hub/src/log-patterns/{loader,matcher,events,index,types}.ts` — registry loader, matcher, DB helpers, singleton accessor.
- Hook in `logCache.writeLogs` runs the matcher after Drain template mining.
- `generateInsights` materializes one insight per `(host, container, pattern_id)` from `log_pattern_events`.
- `processAlerts` calls `findForAlertType` after each new alert_state INSERT and stamps `explained_by_pattern_event_id` on the first match.
- Frontend `LogMatchBlock` extras component + "↳ likely cause" chip on alert rows.

## Test plan
- [x] `npm test` (root): full suite green
- [x] `cd hub && npx tsc --noEmit` clean
- [x] `cd hub/src/web/frontend && npx tsc --noEmit && npm run build` green
- [x] Unit: loader (6), matcher (10), events (5)
- [x] Integration: log-patterns-pipeline (3 cases — insight materialization, alert stamping, no-stamp negative)
- [ ] Manual on vdev: trigger Jellyfin truncated-mkv → insight + alert chip visible

## Notable design decisions
- UNIQUE(host, container, pattern_id, line_hash) collapses repeat lines via UPSERT; no time-based cooldown.
- `explained_by_pattern_event_id` does NOT suppress the alert — the symptom stays visible, the cause is shown alongside it.
- Registry reload requires hub restart (file-watch deferred).
- Per-pattern severity in YAML; insight severity hardcoded to 'warning' in v1 (per-pattern overlay deferred).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Return the PR URL.

- [ ] **Step 15.4: After merge — update memory**

Append a chronology bullet to `MEMORY.md`'s insightd index line capturing:
- PR # + schema v54 (log_pattern_events + alert_state.explained_by_pattern_event_id)
- YAML registry location + filename → file-key convention
- Loader behaviors (skip on missing images, duplicate-id rejection)
- Matcher behaviors (tag-stripped image match, 4KB truncation, N=3 context, named captures)
- UPSERT-on-repeat semantics
- Alert stamping (15min lookback window, sticky first-match)
- Naming difference vs spec (any divergences)
- Jellyfin pattern file ships with 3 patterns

---

## Self-review notes

**Spec coverage check:**
- YAML registry source + loader → Task 2
- Hub-side matcher on existing fetches → Task 6
- Standalone insight + diagnoser signal → Task 7 covers insight; diagnoser signal consumes via `findRecent` (no new Task — existing diagnosers can opt in later, the API is in place)
- Image: [] glob list → Task 2 (loader.parseImageMatcher) + Task 3 (matcher.matchesImage)
- Matched line + context + captures evidence → Task 3 (matcher) + Task 5 (events) + Task 9 (explain) + Task 10 (frontend)
- log_pattern_events persistence + UPSERT → Task 4 (schema) + Task 5 (events)
- `explains_alert` + alert_state stamping → Task 4 (column) + Task 8 (processAlerts)
- Jellyfin-only first cut + CONTRIBUTING.md → Task 13
- Env knobs → Task 12
- Retention prune → Task 4 (initial 7-day) + Task 12 (env-driven override)

**Placeholder scan:** No TBDs. Every code step shows the code. The alerts-page-component file path in Task 11 is deferred to runtime grep (the file's name varies; Task 11 walks the engineer through the lookup).

**Type-consistency check:**
- `Pattern.explainsAlert` (camelCase, TS-side) ↔ YAML `explains_alert` (snake_case, wire) ↔ DB column `explained_by_pattern_event_id`. Loader maps YAML snake → TS camel. Consistent across tasks.
- `MatchEvent` fields camelCase end-to-end in TS. SQL columns snake_case. `recordMatch` serializes JSON arrays/objects via `JSON.stringify` and `findRecent` returns the raw string columns; consumers parse. Done in Task 5 (events.ts) and Task 7 (detector.ts).
- `ExtraBlock` union extends from PR #275's `TopArgvsBlock` to add `LogMatchBlock`. Both backend (Task 9) and frontend api.ts (Task 10) extend.
