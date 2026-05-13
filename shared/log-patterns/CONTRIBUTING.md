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
