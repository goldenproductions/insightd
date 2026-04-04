# Insight Features — Timeline, Rankings, Trends, Events, Disk Forecast

> Status: **Implemented**

## Features

### 1. Container Uptime Timeline
Visual bar per container showing uptime/downtime over 7 days. Green blocks for running, red for down, gray for no data. 168 hourly slots.
- API: `GET /api/hosts/:hostId/timeline?days=7`

### 2. Resource Rankings
"Top consumers" — which containers use the most CPU and RAM across all hosts.
- API: `GET /api/rankings?metric=cpu&limit=10`

### 3. Trend Comparison (This Week vs Last Week)
Per-container and per-host resource trends. Flags >10% changes.
- API: `GET /api/hosts/:hostId/trends`

### 4. Event Timeline
Chronological feed of container restarts, status changes, alert triggers/resolutions.
- API: `GET /api/hosts/:hostId/events?days=7`

### 5. Disk Forecast
Linear projection from historical usage. "At current rate, disk will be full in X days."
- Added to `GET /api/hosts/:hostId` response

## Key Files
- `hub/src/web/queries.js` — 5 query functions
- `hub/src/web/handlers.js` — 4 handlers
- `hub/src/web/server.js` — 4 routes
