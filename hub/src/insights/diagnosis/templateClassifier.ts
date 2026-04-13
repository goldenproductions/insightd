/**
 * Template semantic classifier — the 17 error-pattern regexes from the
 * pre-Drain logCache, re-framed as a one-shot overlay applied once per newly
 * created template rather than per log line.
 *
 * When Drain creates a template, we run the template string against this list
 * and attach a semantic tag (e.g. `'oom'`, `'panic'`, `'conn_refused'`) so
 * downstream diagnosers can recognize known failure classes without running
 * regexes in the hot path on every log line.
 */

export interface SemanticRule {
  tag: string;
  label: string;
  re: RegExp;
}

export const SEMANTIC_RULES: readonly SemanticRule[] = [
  { tag: 'oom',            label: 'out of memory',         re: /out of memory|oom[-_ ]?killed|cannot allocate memory/i },
  { tag: 'panic',          label: 'panic',                 re: /panic:/i },
  { tag: 'segfault',       label: 'segmentation fault',    re: /segmentation fault|sigsegv/i },
  { tag: 'fatal',          label: 'fatal error',           re: /fatal:/i },
  { tag: 'conn_refused',   label: 'connection refused',    re: /connection refused/i },
  { tag: 'conn_reset',     label: 'connection reset',      re: /connection reset/i },
  { tag: 'conn_timeout',   label: 'connection timeout',    re: /i\/o timeout|connection timed out/i },
  { tag: 'dns_fail',       label: 'DNS resolution failure', re: /no such host|name resolution|could not resolve/i },
  { tag: 'permission',     label: 'permission denied',     re: /permission denied|eacces/i },
  { tag: 'disk_full',      label: 'disk full',             re: /disk full|no space left|enospc/i },
  { tag: 'too_many_files', label: 'too many open files',   re: /too many open files|emfile/i },
  { tag: 'db_locked',      label: 'database locked',       re: /database is locked|sqlite_busy/i },
  { tag: 'http_401',       label: 'HTTP 401 unauthorized', re: /unauthorized|\b401\b/i },
  { tag: 'http_403',       label: 'HTTP 403 forbidden',    re: /forbidden|\b403\b/i },
  { tag: 'http_404',       label: 'HTTP 404 not found',    re: /not found|\b404\b/i },
  { tag: 'http_502',       label: 'HTTP 502 bad gateway',  re: /bad gateway|\b502\b/i },
  { tag: 'http_503',       label: 'HTTP 503 unavailable',  re: /service unavailable|\b503\b/i },
] as const;

/**
 * Given a template string (possibly containing `<*>` wildcards), return the
 * first matching semantic tag or null.
 */
export function classifyTemplate(template: string): string | null {
  for (const rule of SEMANTIC_RULES) {
    if (rule.re.test(template)) return rule.tag;
  }
  return null;
}

/**
 * Human-readable label for a semantic tag. Used by diagnosers when rendering
 * evidence strings so the UI still shows "out of memory" instead of "oom".
 */
export function labelForTag(tag: string | null): string | null {
  if (!tag) return null;
  const rule = SEMANTIC_RULES.find((r) => r.tag === tag);
  return rule ? rule.label : tag;
}

module.exports = {
  SEMANTIC_RULES,
  classifyTemplate,
  labelForTag,
};
