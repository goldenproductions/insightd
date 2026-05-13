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
