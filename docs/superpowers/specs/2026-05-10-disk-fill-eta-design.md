# Disk-fill ETA insights

**Status:** design
**Date:** 2026-05-10
**Author:** Andreas (with Claude)
**Sub-project of:** Insights coverage expansion (parent roadmap: HTTP endpoint insights, disk-fill ETA, log-pattern standalone insights, cluster-wide patterns — this spec covers disk-fill ETA only).

## Summary

Predict when a disk or Proxmox storage pool will run out of space, and surface it as a `prediction`-category insight before the existing `disk_full` / `pve_storage_saturation` alerts fire. Mirrors the existing host-CPU and host-memory prediction insights in shape, severity, and 14-day horizon.

Sources: `disk_snapshots` (Linux mounts) and `pve_storage_snapshots` (Proxmox storage pools). Volumes, k8s PVs, and PVCs are deferred — their snapshot tables only carry declared capacity, not actual usage, so ETA is not computable without new collection.

## Goals

- Surface disks/pools that will fill within 14 days at current growth rate.
- Reuse existing `prediction` category, severity bar (critical ≤3 days, warning ≤14 days), and detector cycle.
- Stay quiet on idle disks (floor at 50% used) and avoid duplicating the `disk_full` / `pve_storage_saturation` alerts when those are already open.
- Self-clear when the trend reverses (handled by detector's existing wipe-and-rewrite cycle).

## Non-goals

- New alert type or webhook delivery — insights only. The existing `disk_full` and `pve_storage_saturation` alerts continue to handle hard saturation.
- Volume / PV / PVC fill ETA. Their schemas (`volume_snapshots.size_bytes`, `pv_snapshots.capacity_bytes`, `pvc_snapshots.request_bytes`/`capacity_bytes`) carry only declared/total capacity. Adding usage collection is a separate sub-project.
- Per-disk silencing UI. Insights are not silenceable today; if needed it would generalize across all insights, not just disk-fill.
- A configurable horizon. 14 days mirrors host predictions; can be revisited if real usage shows it wrong.

## Architecture

New module `hub/src/insights/disk-fill.ts`. Peer to `proxmox-checks.ts`. Single export:

```ts
export function runDiskFillPredictions(
  db: Database.Database,
  insert: InsightInsert,
): number;
```

`detector.ts` calls it once per cycle from `runDetector()`, accumulating its return value into the existing insight count. One added line of wiring; no other detector changes.

No schema change. Insights are written through the existing 12-column `INSERT` (the same path right-sizing and diagnosis use), so `category`, `metric`, `current_value`, `baseline_value`, `evidence`, `suggested_action`, and `confidence` columns are already in place.

## Detector logic

For each source (disk_snapshots → mount, pve_storage_snapshots → storage pool), iterate (host_id, target):

1. Read latest snapshot. Skip if `total_bytes` is null/0 or `active = 0` (pve_storage only).
2. **Floor:** skip if `used_percent < 50`.
3. **Alert dedup:** skip if an open `alert_state` row exists with `alert_type IN ('disk_full', 'pve_storage_saturation')` and matching host/target.
4. **Trend:** OLS linear regression of usage vs time, over the last 7 days of raw snapshots. For Linux disks, regress on `used_gb`; for pve_storage, on `used_bytes`. Reject if `n < 24` samples (less than ~hourly coverage over the window).
5. **Direction:** skip if `dailyGrowth <= 0`.
6. **ETA:** `daysUntil = round((total - current) / dailyGrowth)`. Skip if `> 14` or `<= 0`.
7. **Severity:** critical if `daysUntil <= 3`, otherwise warning.
8. Insert insight (`prediction` category, `entity_type='host'`, `entity_id=host_id`).

### Insight payload

| Field | Disk variant | pve_storage variant |
|---|---|---|
| `metric` | `disk_used_percent` | `pve_storage_used_percent` |
| `title` | `Disk "{mount}" on {host} filling up` | `Storage pool "{storage}" on {host} filling up` |
| `message` | `{mount} at {used_pct}% ({used}/{total} GB), growing {dailyGrowth} GB/day — full in ~{daysUntil} {day(s)}` | analogous, "{storage}" + bytes-formatted |
| `current_value` | `used_percent` | `used_percent` |
| `baseline_value` | 100 (saturation %) | 100 |
| `evidence` (JSON) | `{ mount_point, used_gb, total_gb, daily_growth_gb, sample_count, slope_r2 }` | `{ storage_name, storage_type, used_bytes, total_bytes, daily_growth_bytes, sample_count, slope_r2 }` |
| `suggested_action` | `Check largest consumers: \`du -h {mount} \| sort -h \| tail -20\`. Common causes: log rotation broken, container volumes, package cache.` | `Inspect with \`pvesm status\` and review per-storage usage in Datacenter → Storage. Common causes: backups accumulating, disk images, ISO uploads.` |
| `confidence` | `medium` | `medium` |

`slope_r2` is included so a future "explanation depth" pass can mark low-r² (noisy) predictions as lower confidence; v1 always uses `medium`.

## Data flow

- **Trigger:** existing hourly `runDetector()` cron in `scheduler.ts`. No new schedule.
- **Wipe-and-rewrite:** detector clears stale insights at cycle start, so disk-fill rows disappear automatically when conditions clear (disk shrinks, alert opens, trend goes flat).
- **Read path:** existing `GET /api/insights` and `InsightsPage.tsx` surface the rows with no frontend change. The 🔮 prediction icon, severity grouping, and current/baseline/deviation card already render correctly for `metric ∈ {disk_used_percent, pve_storage_used_percent}` because the formatter falls through to "percent" rendering.
- **Concurrency:** detector runs serial; no locking concern.

## Edge cases

| Case | Handling |
|---|---|
| Disk shrinking (cleanup happened) | `dailyGrowth <= 0` → skip |
| Brand-new host (<7 days of data) | `n < 24` → skip; reconsider next cycle |
| Disk yo-yos (logs grow then rotate) | OLS averages over 7d; if net-flat → skip |
| Disk replaced / mount remounted (total changes mid-window) | Regression on `used_bytes` still computes a slope; ETA may be off for one cycle, self-corrects next hour |
| pve_storage with `active = 0` | Skip (mirrors `pve_storage_saturation` alert) |
| Mount disappeared from latest snapshot | Loop never visits it; stale insight cleared by cycle wipe |
| `total_bytes` null or 0 | Skip (defensive; `pve_storage_snapshots.total_bytes` is nullable) |
| `current >= total` (impossible but defensive) | Skip — alerts handle it |

Each `(host, target)` iteration is wrapped in try/catch; one failing row logs and continues. Mirrors `runProxmoxChecks`.

Logging: `logger.debug` per insert, one `logger.info` summary line per cycle: `disk-fill predictions: N inserted across M sources`.

## Testing

New file `tests/unit/detector-disk-fill.test.ts`, peer to `detector-proxmox.test.ts` and `detector-right-sizing.test.ts`. Uses `node:test` + tsx (project convention). In-memory SQLite, `applySchema()`, seed rows.

Cases:

| # | Scenario | Expected |
|---|---|---|
| 1 | 1 GB/day growth, 60% used, 100 GB total → ETA 40d | no insight |
| 2 | 5 GB/day growth, 60% used, 100 GB total → ETA 8d | warning insight |
| 3 | 20 GB/day, 60% used, 100 GB total → ETA 2d | critical insight |
| 4 | 30% used (below floor), growing fast | no insight |
| 5 | Disk shrinking | no insight |
| 6 | Flat disk (slope ≈ 0) | no insight |
| 7 | Only 12 samples in 7d window | no insight |
| 8 | Open `disk_full` alert for same (host, mount) | no insight |
| 9 | pve_storage equivalent of #2 | warning, message uses `storage_name` + `pvesm status` |
| 10 | pve_storage with `active = 0` | no insight |
| 11 | Multiple mounts, only one above floor | one insight |
| 12 | Insight evidence JSON shape | parses, contains `daily_growth_gb` + `sample_count` |

Coverage target: every branch in `runDiskFillPredictions`.

**Manual verification post-merge:** vdev deploy, query `SELECT * FROM insights WHERE category='prediction' AND metric LIKE '%disk%'` after one detector cycle on the live VMs (proxmox-01 has a slowly-filling disk — good live signal).

## Risk + rollback

- **Risk:** Wrong slope on noisy disks (logs rotating, snapshots churning) producing flapping insights between cycles. Mitigation: 50% floor, 7d window smooths short-term noise, alert-dedup hides the case where the disk is already flagged.
- **Rollback:** Remove the `runDiskFillPredictions` call from `runDetector()`. New file becomes dead code; safe to leave in place or revert in the same PR. No schema change, no data migration.

## Open questions

- `alert_state` column name for the dedup query: `evaluator.ts:1113` references `target` for `disk_full`. Confirm during implementation that the same column name applies for `pve_storage_saturation`.
- Whether to export `computeMetricTrend` from `detector.ts` for reuse, or inline a small OLS helper in `disk-fill.ts`. Prefer inline to keep the new module standalone unless the existing function maps cleanly.

## Out of scope (followups)

- Volume / PV / PVC fill ETA — needs usage collection.
- HTTP endpoint insights, log-pattern standalone insights, cluster-wide patterns — separate specs.
- Per-disk silence UI.
- Configurable horizon.
- Lowering `confidence` based on `slope_r2` (placeholder evidence field).
