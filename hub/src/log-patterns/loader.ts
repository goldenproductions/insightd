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
