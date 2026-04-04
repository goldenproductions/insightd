# Insights Engine v2: Predictive Alerts, Time-of-Day Baselines, Correlation Detection

> Status: **Implemented** (v0.4.0)

## Three Features

### 1. Time-of-Day Baselines
- 6 time periods (4h windows): night, early_morning, morning, afternoon, evening, late_evening
- Computed per period with MIN_PERIOD_SAMPLES=48 threshold
- Falls back to 'all' bucket when insufficient data

### 2. Predictive Alerts
- Linear regression on 7-day daily averages for CPU, memory, load
- Predicts when metric will exceed P90 baseline
- <=7 days = critical, <=14 days = warning
- Minimum 1%/day growth to avoid noise

### 3. Correlation Detection
- **Cascade**: if >=50% of containers on host have downtime → single host-level insight
- **Temporal**: enriches insight messages with related events on same host within 1 hour

## Key Decisions

- 6 time periods (not 24 hourly) — more samples per bucket = more reliable percentiles
- No schema migration — new time_bucket values and 'prediction' category work with existing tables
- Correlations stored as enriched message text, not separate records
- Optional `hour` parameter on `getBaselines()` for testability
