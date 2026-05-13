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
