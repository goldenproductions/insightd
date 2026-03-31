(function () {
  const $ = (sel) => document.querySelector(sel);
  const app = $('#app');
  let refreshTimer = null;
  let authToken = null;

  // --- API ---
  async function api(path) {
    const res = await fetch(`/api${path}`);
    if (!res.ok) throw new Error(`API ${res.status}`);
    return res.json();
  }

  async function apiAuth(method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (authToken) opts.headers['Authorization'] = `Bearer ${authToken}`;
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`/api${path}`, opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `API ${res.status}`);
    return data;
  }

  // --- Helpers ---
  function timeAgo(dateStr) {
    if (!dateStr) return 'never';
    const diff = Date.now() - new Date(dateStr + 'Z').getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  function statusDot(status) {
    return `<span class="status ${status}"></span>`;
  }

  function diskBar(percent) {
    const color = percent >= 90 ? 'var(--red)' : percent >= 85 ? 'var(--yellow)' : 'var(--green)';
    return `<span class="bar-bg"><span class="bar-fill" style="width:${percent}%;background:${color}"></span></span>`;
  }

  function badge(text, color) {
    return `<span class="badge ${color}">${text}</span>`;
  }

  function esc(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function tableWrap(html) {
    return `<div class="table-wrap">${html}</div>`;
  }

  function fmtBytes(bytes) {
    if (bytes == null) return '-';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
  }

  function fmtUptime(seconds) {
    if (seconds == null) return '-';
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    if (d > 0) return `${d}d ${h}h`;
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  }

  function healthBadge(status) {
    if (!status) return '';
    const color = status === 'healthy' ? 'green' : status === 'unhealthy' ? 'red' : 'yellow';
    return badge(status, color);
  }

  // --- Views ---
  function renderRankingList(items, valueKey, fmtFn) {
    if (!items || items.length === 0) return '<div class="empty">No data</div>';
    const max = Math.max(...items.map(r => r[valueKey] || 0), 1);
    return items.map(r => {
      const pct = Math.round(((r[valueKey] || 0) / max) * 100);
      return `<div class="ranking-row">
        <div class="ranking-name">${esc(r.container_name)} <span class="ranking-host">${esc(r.host_id)}</span></div>
        <div class="ranking-bar-bg"><div class="ranking-bar-fill" style="width:${pct}%"></div></div>
        <div class="ranking-value">${fmtFn(r[valueKey])}</div>
      </div>`;
    }).join('');
  }

  async function renderDashboard() {
    const [data, rankings] = await Promise.all([api('/dashboard'), api('/rankings?limit=5')]);

    const cpuList = renderRankingList(rankings.byCpu, 'cpu_percent', v => v != null ? v.toFixed(1) + '%' : '-');
    const memList = renderRankingList(rankings.byMemory, 'memory_mb', v => v != null ? v.toFixed(0) + ' MB' : '-');

    app.innerHTML = `
      <div class="stats">
        <div class="stat">
          <div class="value">${data.hostsOnline}<span style="font-size:0.9rem;color:var(--text-muted)">/${data.hostCount}</span></div>
          <div class="label">Hosts Online</div>
        </div>
        <div class="stat">
          <div class="value">${data.containersRunning}<span style="font-size:0.9rem;color:var(--text-muted)">/${data.totalContainers}</span></div>
          <div class="label">Containers Running</div>
        </div>
        <div class="stat">
          <div class="value" style="color:${data.activeAlerts > 0 ? 'var(--red)' : 'var(--green)'}">${data.activeAlerts}</div>
          <div class="label">Active Alerts</div>
        </div>
        <div class="stat">
          <div class="value" style="color:${data.diskWarnings > 0 ? 'var(--yellow)' : 'var(--green)'}">${data.diskWarnings}</div>
          <div class="label">Disk Warnings</div>
        </div>
        <div class="stat">
          <div class="value">${data.updatesAvailable}</div>
          <div class="label">Updates Available</div>
        </div>
        ${data.endpointsTotal > 0 ? `<div class="stat">
          <div class="value" style="color:${data.endpointsDown > 0 ? 'var(--red)' : 'var(--green)'}">${data.endpointsUp}<span style="font-size:0.9rem;color:var(--text-muted)">/${data.endpointsTotal}</span></div>
          <div class="label">Endpoints Up</div>
        </div>` : ''}
      </div>

      <div class="card">
        <h2>Top Consumers</h2>
        <div class="rankings-grid">
          <div><h2 style="margin-bottom:0.5rem">CPU</h2>${cpuList}</div>
          <div><h2 style="margin-bottom:0.5rem">Memory</h2>${memList}</div>
        </div>
      </div>

      <div class="refresh-info">Auto-refreshes every 30s</div>
    `;
  }

  async function renderHosts() {
    const hosts = await api('/hosts');
    if (hosts.length === 0) {
      app.innerHTML = '<div class="empty">No hosts connected yet</div>';
      return;
    }

    // Fetch container counts per host in parallel
    const details = await Promise.all(hosts.map(h => api(`/hosts/${encodeURIComponent(h.host_id)}/containers`)));

    let cards = '';
    hosts.forEach((h, i) => {
      const containers = details[i];
      const running = containers.filter(c => c.status === 'running').length;
      const total = containers.length;
      cards += `
        <div class="host-card" onclick="location.hash='#/hosts/${encodeURIComponent(h.host_id)}'">
          <div class="header">
            <span class="host-name">${statusDot(h.is_online ? 'online' : 'offline')} ${esc(h.host_id)}</span>
            ${badge(h.is_online ? 'online' : 'offline', h.is_online ? 'green' : 'red')}
          </div>
          <div class="meta">
            ${running}/${total} containers running<br>
            Last seen ${timeAgo(h.last_seen)}
          </div>
        </div>`;
    });

    app.innerHTML = `
      <div class="section-title">Hosts</div>
      <div class="host-grid">${cards}</div>
      <div class="refresh-info">Auto-refreshes every 30s</div>
    `;
  }

  function trendArrow(change) {
    if (change == null) return '<span class="trend-flat">-</span>';
    if (change > 0) return `<span class="trend-up">+${change}%</span>`;
    if (change < 0) return `<span class="trend-down">${change}%</span>`;
    return '<span class="trend-flat">0%</span>';
  }

  async function renderHostDetail(hostId) {
    const hid = encodeURIComponent(hostId);
    const [data, timeline, trends, events] = await Promise.all([
      api(`/hosts/${hid}`),
      api(`/hosts/${hid}/timeline?days=7`).catch(() => []),
      api(`/hosts/${hid}/trends`).catch(() => ({ containers: [], host: null })),
      api(`/hosts/${hid}/events?days=7`).catch(() => []),
    ]);
    if (!data || data.error) {
      app.innerHTML = `<a class="back" href="#/hosts">&larr; Back</a><div class="empty">Host not found</div>`;
      return;
    }

    // Uptime timeline
    let timelineHtml = '';
    if (timeline.length > 0) {
      const rows = timeline.map(t => {
        const slots = t.slots.map(s => `<div class="timeline-slot ${s}" title="${s}"></div>`).join('');
        const pct = t.uptimePercent != null ? `${t.uptimePercent}%` : '-';
        return `<div class="timeline-row">
          <div class="timeline-name">${esc(t.name)}</div>
          <div class="timeline-bar">${slots}</div>
          <div class="timeline-pct">${pct}</div>
        </div>`;
      }).join('');
      timelineHtml = `<div class="card"><h2>Uptime (7 days)</h2>${rows}</div>`;
    }

    // Containers table
    let containerRows = '';
    for (const c of data.containers) {
      const href = `#/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(c.container_name)}`;
      containerRows += `<tr class="clickable" onclick="location.hash='${href}'">
        <td>${statusDot(c.status)} ${esc(c.container_name)}</td>
        <td>${esc(c.status)}</td>
        <td>${c.cpu_percent != null ? c.cpu_percent.toFixed(1) + '%' : '-'}</td>
        <td>${c.memory_mb != null ? c.memory_mb.toFixed(0) + ' MB' : '-'}</td>
        <td>${c.restart_count}</td>
      </tr>`;
    }

    // Disk table
    let diskRows = '';
    for (const d of data.disk) {
      diskRows += `<tr>
        <td>${esc(d.mount_point)}</td>
        <td>${d.used_gb.toFixed(1)} / ${d.total_gb.toFixed(1)} GB</td>
        <td>${diskBar(d.used_percent)} ${d.used_percent.toFixed(1)}%</td>
      </tr>`;
    }

    // Alerts table
    let alertRows = '';
    for (const a of data.alerts) {
      alertRows += `<tr class="alert-row">
        <td>${esc(a.alert_type)}</td>
        <td>${esc(a.target)}</td>
        <td>${timeAgo(a.triggered_at)}</td>
        <td>${a.notify_count}</td>
      </tr>`;
    }

    // Updates
    let updateRows = '';
    for (const u of data.updates) {
      updateRows += `<tr>
        <td>${esc(u.container_name)}</td>
        <td>${esc(u.image)}</td>
      </tr>`;
    }

    // Host system metrics card
    let hostMetricsCard = '';
    const hm = data.hostMetrics;
    if (hm) {
      const memPct = hm.memory_total_mb ? Math.round((hm.memory_used_mb / hm.memory_total_mb) * 100) : null;
      hostMetricsCard = `
      <div class="stats">
        <div class="stat">
          <div class="value">${hm.cpu_percent != null ? hm.cpu_percent.toFixed(1) + '%' : '-'}</div>
          <div class="label">Host CPU</div>
        </div>
        <div class="stat">
          <div class="value">${memPct != null ? memPct + '%' : '-'}</div>
          <div class="label">Host Memory</div>
        </div>
        <div class="stat">
          <div class="value">${hm.load_1 != null ? hm.load_1.toFixed(2) : '-'}</div>
          <div class="label">Load 1m</div>
        </div>
        <div class="stat">
          <div class="value">${hm.load_5 != null ? hm.load_5.toFixed(2) : '-'}</div>
          <div class="label">Load 5m</div>
        </div>
        <div class="stat">
          <div class="value">${fmtUptime(hm.uptime_seconds)}</div>
          <div class="label">Uptime</div>
        </div>
      </div>`;
    }

    // Trends card
    let trendsHtml = '';
    if (trends.containers.length > 0) {
      const trendRows = trends.containers.map(t => {
        const cls = t.flagged ? ' class="trend-flagged"' : '';
        return `<tr${cls}>
          <td>${esc(t.name)}</td>
          <td>${t.cpuNow != null ? t.cpuNow + '%' : '-'} ${trendArrow(t.cpuChange)}</td>
          <td>${t.memNow != null ? t.memNow + ' MB' : '-'} ${trendArrow(t.memChange)}</td>
        </tr>`;
      }).join('');
      const hostRow = trends.host ? `<tr style="font-weight:600">
        <td>Host</td>
        <td>${trends.host.cpuNow != null ? trends.host.cpuNow + '%' : '-'} ${trendArrow(trends.host.cpuChange)}</td>
        <td>${trends.host.memNow != null ? trends.host.memNow + ' MB' : '-'} ${trendArrow(trends.host.memChange)}</td>
      </tr>` : '';
      trendsHtml = `<div class="card"><h2>Trends (vs last week)</h2>${tableWrap(`<table>
        <thead><tr><th>Name</th><th>CPU Avg</th><th>Memory Avg</th></tr></thead>
        <tbody>${hostRow}${trendRows}</tbody>
      </table>`)}</div>`;
    }

    // Disk forecast
    let diskForecastHtml = '';
    if (data.diskForecast) {
      diskForecastHtml = data.diskForecast.map(f => {
        if (f.daysUntilFull == null) return `<div class="forecast-text stable">${esc(f.mountPoint)}: Stable — no significant growth</div>`;
        const cls = f.daysUntilFull < 30 ? 'warning' : f.daysUntilFull < 90 ? 'caution' : 'stable';
        return `<div class="forecast-text ${cls}">${esc(f.mountPoint)}: ~${f.daysUntilFull} days until full (${f.dailyGrowthGb} GB/day)</div>`;
      }).join('');
    }

    // Events timeline
    let eventsHtml = '';
    if (events.length > 0) {
      const items = events.slice(0, 30).map(e => `<div class="event-item">
        <div class="event-time">${timeAgo(e.time)}</div>
        <div class="event-dot ${e.good ? 'good' : 'bad'}"></div>
        <div class="event-msg">${esc(e.message)}</div>
      </div>`).join('');
      eventsHtml = `<div class="card"><h2>Events (7 days)</h2>${items}</div>`;
    }

    app.innerHTML = `
      <a class="back" href="#/hosts">&larr; Back to hosts</a>
      <div class="section-title">${statusDot(data.is_online ? 'online' : 'offline')} ${esc(data.host_id)}</div>

      ${hostMetricsCard}
      ${timelineHtml}

      <div class="card">
        <h2>Containers (${data.containers.length})</h2>
        ${data.containers.length > 0 ? tableWrap(`<table>
          <thead><tr><th>Name</th><th>Status</th><th>CPU</th><th>Memory</th><th>Restarts</th></tr></thead>
          <tbody>${containerRows}</tbody>
        </table>`) : '<div class="empty">No containers</div>'}
      </div>

      ${trendsHtml}

      <div class="card">
        <h2>Disk Usage</h2>
        ${data.disk.length > 0 ? tableWrap(`<table>
          <thead><tr><th>Mount</th><th>Usage</th><th>Percent</th></tr></thead>
          <tbody>${diskRows}</tbody>
        </table>`) : '<div class="empty">No disk data</div>'}
        ${diskForecastHtml}
      </div>

      ${data.alerts.length > 0 ? `<div class="card">
        <h2>Active Alerts (${data.alerts.length})</h2>
        ${tableWrap(`<table>
          <thead><tr><th>Type</th><th>Target</th><th>Triggered</th><th>Notifications</th></tr></thead>
          <tbody>${alertRows}</tbody>
        </table>`)}
      </div>` : ''}

      ${eventsHtml}

      ${data.updates.length > 0 ? `<div class="card">
        <h2>Updates Available (${data.updates.length})</h2>
        ${tableWrap(`<table>
          <thead><tr><th>Container</th><th>Image</th></tr></thead>
          <tbody>${updateRows}</tbody>
        </table>`)}
      </div>` : ''}

      <div class="refresh-info">Auto-refreshes every 30s</div>
    `;
  }

  async function renderAlerts() {
    const alerts = await api('/alerts?active=false');
    if (alerts.length === 0) {
      app.innerHTML = `<div class="section-title">Alerts</div><div class="empty">No alerts</div>`;
      return;
    }

    let rows = '';
    for (const a of alerts) {
      const resolved = a.resolved_at != null;
      rows += `<tr class="alert-row${resolved ? ' resolved' : ''}">
        <td>${statusDot(resolved ? 'green' : 'red')} ${esc(a.alert_type)}</td>
        <td>${esc(a.host_id)}</td>
        <td>${esc(a.target)}</td>
        <td>${timeAgo(a.triggered_at)}</td>
        <td>${resolved ? timeAgo(a.resolved_at) : badge('active', 'red')}</td>
        <td>${a.notify_count}</td>
      </tr>`;
    }

    app.innerHTML = `
      <div class="section-title">Alerts</div>
      <div class="card">
        ${tableWrap(`<table>
          <thead><tr><th>Type</th><th>Host</th><th>Target</th><th>Triggered</th><th>Resolved</th><th>Notifications</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`)}
      </div>
      <div class="refresh-info">Auto-refreshes every 30s</div>
    `;
  }

  async function renderContainerDetail(hostId, containerName) {
    const data = await api(`/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(containerName)}`);
    if (!data || data.error) {
      app.innerHTML = `<a class="back" href="#/hosts/${encodeURIComponent(hostId)}">&larr; Back</a><div class="empty">Container not found</div>`;
      return;
    }

    // Summary stats from history
    const history = data.history || [];
    const runningCount = history.filter(h => h.status === 'running').length;
    const uptimePercent = history.length > 0 ? ((runningCount / history.length) * 100).toFixed(1) : '-';
    const cpuValues = history.filter(h => h.cpu_percent != null).map(h => h.cpu_percent);
    const memValues = history.filter(h => h.memory_mb != null).map(h => h.memory_mb);
    const avgCpu = cpuValues.length > 0 ? (cpuValues.reduce((a, b) => a + b, 0) / cpuValues.length).toFixed(1) : '-';
    const maxCpu = cpuValues.length > 0 ? Math.max(...cpuValues).toFixed(1) : '-';
    const avgMem = memValues.length > 0 ? (memValues.reduce((a, b) => a + b, 0) / memValues.length).toFixed(0) : '-';
    const maxMem = memValues.length > 0 ? Math.max(...memValues).toFixed(0) : '-';

    // Restart delta over the history window
    const restartValues = history.map(h => h.restart_count);
    const restartDelta = restartValues.length >= 2 ? restartValues[restartValues.length - 1] - restartValues[0] : 0;

    // History table (most recent first, cap at 50 rows)
    const recentHistory = history.slice().reverse().slice(0, 50);
    let historyRows = '';
    for (const h of recentHistory) {
      historyRows += `<tr>
        <td>${timeAgo(h.collected_at)}</td>
        <td>${statusDot(h.status)} ${esc(h.status)}</td>
        <td>${h.cpu_percent != null ? h.cpu_percent.toFixed(1) + '%' : '-'}</td>
        <td>${h.memory_mb != null ? h.memory_mb.toFixed(0) + ' MB' : '-'}</td>
        <td>${h.restart_count}</td>
      </tr>`;
    }

    // Sparkline (simple ASCII-style bar chart for CPU)
    let cpuChart = '';
    if (cpuValues.length > 1) {
      const maxVal = Math.max(...cpuValues, 1);
      const barCount = Math.min(cpuValues.length, 60);
      const step = Math.max(1, Math.floor(cpuValues.length / barCount));
      const sampled = [];
      for (let i = 0; i < cpuValues.length; i += step) sampled.push(cpuValues[i]);
      cpuChart = `<div class="card"><h2>CPU (last 24h)</h2><div class="chart">${
        sampled.map(v => {
          const h = Math.max(2, Math.round((v / maxVal) * 40));
          const color = v > 90 ? 'var(--red)' : v > 70 ? 'var(--yellow)' : 'var(--green)';
          return `<span class="chart-bar" style="height:${h}px;background:${color}" title="${v.toFixed(1)}%"></span>`;
        }).join('')
      }</div><div class="chart-label"><span>0%</span><span>${maxVal.toFixed(0)}%</span></div></div>`;
    }

    let memChart = '';
    if (memValues.length > 1) {
      const maxVal = Math.max(...memValues, 1);
      const barCount = Math.min(memValues.length, 60);
      const step = Math.max(1, Math.floor(memValues.length / barCount));
      const sampled = [];
      for (let i = 0; i < memValues.length; i += step) sampled.push(memValues[i]);
      memChart = `<div class="card"><h2>Memory (last 24h)</h2><div class="chart">${
        sampled.map(v => {
          const h = Math.max(2, Math.round((v / maxVal) * 40));
          return `<span class="chart-bar" style="height:${h}px;background:var(--blue)" title="${v.toFixed(0)} MB"></span>`;
        }).join('')
      }</div><div class="chart-label"><span>0 MB</span><span>${maxVal.toFixed(0)} MB</span></div></div>`;
    }

    // Alerts for this container
    let alertSection = '';
    if (data.alerts && data.alerts.length > 0) {
      let alertRows = '';
      for (const a of data.alerts) {
        const resolved = a.resolved_at != null;
        alertRows += `<tr class="alert-row${resolved ? ' resolved' : ''}">
          <td>${statusDot(resolved ? 'green' : 'red')} ${esc(a.alert_type)}</td>
          <td>${timeAgo(a.triggered_at)}</td>
          <td>${resolved ? timeAgo(a.resolved_at) : badge('active', 'red')}</td>
          <td>${a.notify_count}</td>
        </tr>`;
      }
      alertSection = `<div class="card">
        <h2>Alerts</h2>
        ${tableWrap(`<table>
          <thead><tr><th>Type</th><th>Triggered</th><th>Resolved</th><th>Notifications</th></tr></thead>
          <tbody>${alertRows}</tbody>
        </table>`)}
      </div>`;
    }

    app.innerHTML = `
      <a class="back" href="#/hosts/${encodeURIComponent(hostId)}">&larr; Back to ${esc(hostId)}</a>
      <div class="section-title">${statusDot(data.status)} ${esc(data.container_name)}</div>

      <div class="stats">
        <div class="stat">
          <div class="value">${esc(data.status)}</div>
          <div class="label">Status</div>
        </div>
        <div class="stat">
          <div class="value">${healthBadge(data.health_status) || '-'}</div>
          <div class="label">Health</div>
        </div>
        <div class="stat">
          <div class="value">${uptimePercent}${uptimePercent !== '-' ? '%' : ''}</div>
          <div class="label">Uptime (24h)</div>
        </div>
        <div class="stat">
          <div class="value">${data.cpu_percent != null ? data.cpu_percent.toFixed(1) + '%' : '-'}</div>
          <div class="label">CPU Now</div>
        </div>
        <div class="stat">
          <div class="value">${data.memory_mb != null ? data.memory_mb.toFixed(0) + ' MB' : '-'}</div>
          <div class="label">Memory Now</div>
        </div>
        <div class="stat">
          <div class="value">${restartDelta}</div>
          <div class="label">Restarts (24h)</div>
        </div>
      </div>

      <div class="stats">
        <div class="stat">
          <div class="value">${avgCpu}${avgCpu !== '-' ? '%' : ''}</div>
          <div class="label">Avg CPU (24h)</div>
        </div>
        <div class="stat">
          <div class="value">${maxCpu}${maxCpu !== '-' ? '%' : ''}</div>
          <div class="label">Peak CPU (24h)</div>
        </div>
        <div class="stat">
          <div class="value">${avgMem !== '-' ? avgMem + ' MB' : '-'}</div>
          <div class="label">Avg Memory (24h)</div>
        </div>
        <div class="stat">
          <div class="value">${maxMem !== '-' ? maxMem + ' MB' : '-'}</div>
          <div class="label">Peak Memory (24h)</div>
        </div>
        <div class="stat">
          <div class="value">${fmtBytes(data.network_rx_bytes)}</div>
          <div class="label">Net RX</div>
        </div>
        <div class="stat">
          <div class="value">${fmtBytes(data.network_tx_bytes)}</div>
          <div class="label">Net TX</div>
        </div>
        <div class="stat">
          <div class="value">${fmtBytes(data.blkio_read_bytes)}</div>
          <div class="label">Disk Read</div>
        </div>
        <div class="stat">
          <div class="value">${fmtBytes(data.blkio_write_bytes)}</div>
          <div class="label">Disk Write</div>
        </div>
      </div>

      ${cpuChart}
      ${memChart}
      ${alertSection}

      <div class="card">
        <h2>Logs</h2>
        <div class="log-controls">
          <select id="log-stream">
            <option value="both">All streams</option>
            <option value="stdout">stdout</option>
            <option value="stderr">stderr</option>
          </select>
          <input id="log-lines" type="number" value="100" min="1" max="1000" title="Lines">
          <button id="log-load">Load Logs</button>
          <button id="log-refresh" style="display:none">Refresh</button>
        </div>
        <div id="log-output"></div>
      </div>

      <div class="card">
        <h2>History (${history.length} snapshots)</h2>
        ${historyRows ? tableWrap(`<table>
          <thead><tr><th>Time</th><th>Status</th><th>CPU</th><th>Memory</th><th>Restarts</th></tr></thead>
          <tbody>${historyRows}</tbody>
        </table>`) : '<div class="empty">No history data</div>'}
      </div>

      <div class="refresh-info">Auto-refreshes every 30s</div>
    `;

    // Wire up log buttons
    const logLoad = document.getElementById('log-load');
    const logRefresh = document.getElementById('log-refresh');
    const logOutput = document.getElementById('log-output');

    async function loadLogs() {
      const stream = document.getElementById('log-stream').value;
      const lines = document.getElementById('log-lines').value || '100';
      logOutput.innerHTML = '<div class="empty">Loading logs...</div>';
      logLoad.disabled = true;
      try {
        const result = await api(`/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(containerName)}/logs?lines=${lines}&stream=${stream}`);
        if (result.error) {
          logOutput.innerHTML = `<div class="empty">${esc(result.error)}</div>`;
        } else if (!result.logs || result.logs.length === 0) {
          logOutput.innerHTML = '<div class="empty">No logs available</div>';
        } else {
          const html = result.logs.map(l => {
            const ts = l.timestamp ? `<span class="log-ts">${esc(l.timestamp.slice(11, 23))}</span> ` : '';
            const cls = l.stream === 'stderr' ? ' stderr' : '';
            return `<div class="log-line${cls}">${ts}${esc(l.message)}</div>`;
          }).join('');
          logOutput.innerHTML = `<pre class="log-viewer">${html}</pre>`;
          logOutput.querySelector('.log-viewer').scrollTop = logOutput.querySelector('.log-viewer').scrollHeight;
        }
        logRefresh.style.display = '';
      } catch (err) {
        logOutput.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
      }
      logLoad.disabled = false;
    }

    logLoad.addEventListener('click', loadLogs);
    logRefresh.addEventListener('click', loadLogs);
  }

  // --- Endpoints ---
  async function renderEndpoints() {
    const endpoints = await api('/endpoints');

    let addBtn = '';
    if (authToken) {
      addBtn = '<a href="#/endpoints/new" class="btn-primary" style="float:right;text-decoration:none;margin-top:-0.5rem">Add Endpoint</a>';
    }

    if (endpoints.length === 0) {
      app.innerHTML = `
        <div class="section-title">Endpoints ${addBtn}</div>
        <div class="empty">No endpoints configured. ${authToken ? '<a href="#/endpoints/new">Add one</a>.' : 'Log in to add endpoints.'}</div>
      `;
      return;
    }

    let rows = '';
    for (const ep of endpoints) {
      const isUp = ep.lastCheck ? ep.lastCheck.is_up : null;
      const statusClass = isUp === null ? 'none' : isUp ? 'running' : 'exited';
      const uptime = ep.uptimePercent24h != null ? ep.uptimePercent24h + '%' : '-';
      const avgMs = ep.avgResponseMs != null ? ep.avgResponseMs + 'ms' : '-';
      const lastChecked = ep.lastCheck ? timeAgo(ep.lastCheck.checked_at) : 'never';
      rows += `<tr style="cursor:pointer" onclick="location.hash='#/endpoints/${ep.id}'">
        <td>${statusDot(statusClass)} ${esc(ep.name)}</td>
        <td class="url-cell">${esc(ep.url)}</td>
        <td>${uptime}</td>
        <td>${avgMs}</td>
        <td>${lastChecked}</td>
        <td>${ep.enabled ? badge('on', 'green') : badge('off', 'red')}</td>
      </tr>`;
    }

    app.innerHTML = `
      <div class="section-title">Endpoints ${addBtn}</div>
      <div class="card">
        ${tableWrap(`<table>
          <thead><tr><th>Name</th><th>URL</th><th>Uptime (24h)</th><th>Avg Response</th><th>Last Check</th><th>Status</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`)}
      </div>
      <div class="refresh-info">Auto-refreshes every 30s</div>
    `;
  }

  async function renderEndpointDetail(id) {
    const data = await api(`/endpoints/${id}`);
    if (data.error) {
      app.innerHTML = `<a class="back" href="#/endpoints">&larr; Back</a><div class="empty">Endpoint not found</div>`;
      return;
    }

    const checks = await api(`/endpoints/${id}/checks?hours=24`);

    const isUp = data.lastCheck ? data.lastCheck.is_up : null;
    const statusClass = isUp === null ? 'none' : isUp ? 'running' : 'exited';
    const statusText = isUp === null ? 'No data' : isUp ? 'Up' : 'Down';

    // Response time chart
    let rtChart = '';
    const rtValues = checks.filter(c => c.response_time_ms != null).reverse().map(c => c.response_time_ms);
    if (rtValues.length > 1) {
      const maxVal = Math.max(...rtValues, 1);
      const barCount = Math.min(rtValues.length, 60);
      const step = Math.max(1, Math.floor(rtValues.length / barCount));
      const sampled = [];
      for (let i = 0; i < rtValues.length; i += step) sampled.push(rtValues[i]);
      rtChart = `<div class="card"><h2>Response Time (last 24h)</h2><div class="chart">${
        sampled.map(v => {
          const h = Math.max(2, Math.round((v / maxVal) * 40));
          const color = v > 2000 ? 'var(--red)' : v > 500 ? 'var(--yellow)' : 'var(--green)';
          return `<span class="chart-bar" style="height:${h}px;background:${color}" title="${v}ms"></span>`;
        }).join('')
      }</div><div class="chart-label"><span>0ms</span><span>${maxVal}ms</span></div></div>`;
    }

    // Check history table
    let historyRows = '';
    for (const c of checks.slice(0, 50)) {
      const dot = c.is_up ? statusDot('running') : statusDot('exited');
      historyRows += `<tr>
        <td>${timeAgo(c.checked_at)}</td>
        <td>${dot} ${c.status_code || '-'}</td>
        <td>${c.response_time_ms != null ? c.response_time_ms + 'ms' : '-'}</td>
        <td>${c.error ? esc(c.error) : '-'}</td>
      </tr>`;
    }

    let editBtn = '';
    if (authToken) {
      editBtn = `<a href="#/endpoints/${id}/edit" class="btn-primary" style="text-decoration:none;margin-left:1rem">Edit</a>`;
    }

    app.innerHTML = `
      <a class="back" href="#/endpoints">&larr; Back to Endpoints</a>
      <div class="section-title">${statusDot(statusClass)} ${esc(data.name)} ${editBtn}</div>
      <div style="color:var(--text-muted);margin-bottom:1rem">${esc(data.url)} &middot; ${esc(data.method)} &middot; Expects ${data.expected_status} &middot; Every ${data.interval_seconds}s</div>

      <div class="stats">
        <div class="stat">
          <div class="value" style="color:${isUp ? 'var(--green)' : 'var(--red)'}">${statusText}</div>
          <div class="label">Current</div>
        </div>
        <div class="stat">
          <div class="value">${data.uptimePercent24h != null ? data.uptimePercent24h + '%' : '-'}</div>
          <div class="label">Uptime (24h)</div>
        </div>
        <div class="stat">
          <div class="value">${data.uptimePercent7d != null ? data.uptimePercent7d + '%' : '-'}</div>
          <div class="label">Uptime (7d)</div>
        </div>
        <div class="stat">
          <div class="value">${data.avgResponseMs != null ? data.avgResponseMs + 'ms' : '-'}</div>
          <div class="label">Avg Response (24h)</div>
        </div>
        <div class="stat">
          <div class="value">${data.lastCheck ? (data.lastCheck.response_time_ms || '-') + 'ms' : '-'}</div>
          <div class="label">Last Response</div>
        </div>
      </div>

      ${rtChart}

      <div class="card">
        <h2>Check History (${checks.length} checks)</h2>
        ${historyRows ? tableWrap(`<table>
          <thead><tr><th>Time</th><th>Status</th><th>Response</th><th>Error</th></tr></thead>
          <tbody>${historyRows}</tbody>
        </table>`) : '<div class="empty">No checks yet</div>'}
      </div>

      <div class="refresh-info">Auto-refreshes every 30s</div>
    `;
  }

  async function renderEndpointForm(id) {
    if (!authToken) {
      renderLogin();
      return;
    }

    let existing = null;
    if (id) {
      existing = await api(`/endpoints/${id}`);
      if (existing.error) {
        app.innerHTML = `<a class="back" href="#/endpoints">&larr; Back</a><div class="empty">Endpoint not found</div>`;
        return;
      }
    }

    const title = existing ? 'Edit Endpoint' : 'Add Endpoint';
    const backHref = existing ? `#/endpoints/${id}` : '#/endpoints';

    app.innerHTML = `
      <a class="back" href="${backHref}">&larr; Back</a>
      <div class="section-title">${title}</div>
      <div class="card" style="max-width:600px">
        <div class="form-group">
          <label>Name</label>
          <input type="text" id="ep-name" value="${esc(existing ? existing.name : '')}" placeholder="e.g. My API Health Check" maxlength="100">
        </div>
        <div class="form-group">
          <label>URL</label>
          <input type="text" id="ep-url" value="${esc(existing ? existing.url : '')}" placeholder="https://api.example.com/health">
        </div>
        <div class="form-group">
          <label>Method</label>
          <select id="ep-method">
            <option value="GET"${!existing || existing.method === 'GET' ? ' selected' : ''}>GET</option>
            <option value="HEAD"${existing && existing.method === 'HEAD' ? ' selected' : ''}>HEAD</option>
          </select>
        </div>
        <div class="form-group">
          <label>Expected Status Code</label>
          <input type="number" id="ep-status" value="${existing ? existing.expected_status : 200}" min="100" max="599">
        </div>
        <div class="form-group">
          <label>Check Interval (seconds)</label>
          <input type="number" id="ep-interval" value="${existing ? existing.interval_seconds : 60}" min="10" max="3600">
        </div>
        <div class="form-group">
          <label>Timeout (ms)</label>
          <input type="number" id="ep-timeout" value="${existing ? existing.timeout_ms : 10000}" min="1000" max="30000">
        </div>
        <div class="form-group">
          <label>Custom Headers (JSON, optional)</label>
          <input type="text" id="ep-headers" value="${esc(existing && existing.headers ? existing.headers : '')}" placeholder='{"Authorization":"Bearer ..."}'>
        </div>
        <div class="form-group">
          <label>Enabled</label>
          <select id="ep-enabled">
            <option value="1"${!existing || existing.enabled ? ' selected' : ''}>Yes</option>
            <option value="0"${existing && !existing.enabled ? ' selected' : ''}>No</option>
          </select>
        </div>
        <div id="ep-msg"></div>
        <div class="form-actions">
          <button id="ep-save" class="btn-primary">${existing ? 'Update' : 'Create'}</button>
          ${existing ? '<button id="ep-delete" class="btn-danger">Delete</button>' : ''}
        </div>
      </div>
    `;

    document.getElementById('ep-save').addEventListener('click', async () => {
      const body = {
        name: document.getElementById('ep-name').value,
        url: document.getElementById('ep-url').value,
        method: document.getElementById('ep-method').value,
        expectedStatus: parseInt(document.getElementById('ep-status').value, 10),
        intervalSeconds: parseInt(document.getElementById('ep-interval').value, 10),
        timeoutMs: parseInt(document.getElementById('ep-timeout').value, 10),
        headers: document.getElementById('ep-headers').value || null,
        enabled: document.getElementById('ep-enabled').value === '1',
      };
      const msgEl = document.getElementById('ep-msg');
      try {
        if (existing) {
          await apiAuth('PUT', `/endpoints/${id}`, body);
          msgEl.innerHTML = '<div class="alert-banner green">Endpoint updated.</div>';
        } else {
          const result = await apiAuth('POST', '/endpoints', body);
          msgEl.innerHTML = '<div class="alert-banner green">Endpoint created.</div>';
          setTimeout(() => { location.hash = `#/endpoints/${result.id}`; }, 500);
        }
      } catch (err) {
        msgEl.innerHTML = `<div class="alert-banner red">${esc(err.message)}</div>`;
      }
    });

    if (existing) {
      document.getElementById('ep-delete').addEventListener('click', async () => {
        if (!confirm('Delete this endpoint and all its check history?')) return;
        try {
          await apiAuth('DELETE', `/endpoints/${id}`);
          location.hash = '#/endpoints';
        } catch (err) {
          document.getElementById('ep-msg').innerHTML = `<div class="alert-banner red">${esc(err.message)}</div>`;
        }
      });
    }
  }

  // --- Settings ---
  async function renderSettings() {
    if (!authToken) {
      renderLogin();
      return;
    }

    try {
      const data = await apiAuth('GET', '/settings');
      const categories = data.categories;
      let html = '<div class="section-title">Settings</div>';

      for (const [category, settings] of Object.entries(categories)) {
        let fields = '';
        for (const s of settings) {
          const restart = s.hotReload ? '' : '<span class="form-hint">(requires restart)</span>';
          const src = `<span class="form-source">${s.source}</span>`;
          let input;
          if (s.type === 'bool') {
            input = `<select name="${esc(s.key)}" data-key="${esc(s.key)}">
              <option value="true"${s.value === 'true' ? ' selected' : ''}>true</option>
              <option value="false"${s.value !== 'true' ? ' selected' : ''}>false</option>
            </select>`;
          } else if (s.sensitive) {
            input = `<input type="password" name="${esc(s.key)}" data-key="${esc(s.key)}" value="${esc(s.value)}" placeholder="unchanged">`;
          } else if (s.type === 'int' || s.type === 'float') {
            input = `<input type="number" name="${esc(s.key)}" data-key="${esc(s.key)}" value="${esc(s.value)}" step="${s.type === 'float' ? '0.1' : '1'}">`;
          } else {
            input = `<input type="text" name="${esc(s.key)}" data-key="${esc(s.key)}" value="${esc(s.value)}">`;
          }
          const desc = s.description ? `<div class="form-description">${esc(s.description)}</div>` : '';
          fields += `<div class="form-group">
            <label>${esc(s.label)} ${restart} ${src}</label>
            ${input}${desc}
          </div>`;
        }
        html += `<div class="card"><h2>${esc(category)}</h2>${fields}</div>`;
      }

      html += '<div class="form-actions"><button id="settings-save" class="btn-primary">Save Settings</button></div>';
      html += '<div id="settings-msg"></div>';

      app.innerHTML = html;

      document.getElementById('settings-save').addEventListener('click', async () => {
        const entries = {};
        document.querySelectorAll('[data-key]').forEach(el => {
          entries[el.dataset.key] = el.value;
        });
        const msgEl = document.getElementById('settings-msg');
        try {
          const result = await apiAuth('PUT', '/settings', entries);
          if (result.restartRequired) {
            msgEl.innerHTML = '<div class="alert-banner yellow">Settings saved. Some changes require a restart to take effect.</div>';
          } else {
            msgEl.innerHTML = '<div class="alert-banner green">Settings saved.</div>';
          }
        } catch (err) {
          msgEl.innerHTML = `<div class="alert-banner red">${esc(err.message)}</div>`;
        }
      });
    } catch (err) {
      if (err.message.includes('401')) {
        authToken = null;
        renderLogin();
      } else {
        app.innerHTML = `<div class="empty">Error: ${esc(err.message)}</div>`;
      }
    }
  }

  function renderLogin() {
    app.innerHTML = `
      <div class="section-title">Settings</div>
      <div class="card" style="max-width:400px;margin:2rem auto">
        <h2>Admin Login</h2>
        <div class="form-group">
          <label>Password</label>
          <input type="password" id="login-pass" placeholder="Admin password">
        </div>
        <div id="login-msg"></div>
        <div class="form-actions"><button id="login-btn" class="btn-primary">Login</button></div>
      </div>
    `;

    const doLogin = async () => {
      const pass = document.getElementById('login-pass').value;
      try {
        const result = await apiAuth('POST', '/auth', { password: pass });
        authToken = result.token;
        renderSettings();
      } catch (err) {
        document.getElementById('login-msg').innerHTML = `<div class="alert-banner red">Invalid password</div>`;
      }
    };

    document.getElementById('login-btn').addEventListener('click', doLogin);
    document.getElementById('login-pass').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doLogin();
    });
  }

  // --- Add Agent ---
  async function renderAddAgent() {
    const defaults = await api('/agent-setup');

    app.innerHTML = `
      <div class="section-title">Add Agent</div>
      <p style="color:var(--text-muted);margin-bottom:1rem">Configure and copy the command below to deploy an agent on a remote host.</p>

      <div class="card">
        <h2>Agent Configuration</h2>
        <div class="form-group">
          <label>Host ID (unique name for this host)</label>
          <input type="text" id="setup-host-id" placeholder="e.g. nas-01, web-server, pi-cluster-1" value="">
        </div>
        <div class="form-group">
          <label>MQTT URL</label>
          <input type="text" id="setup-mqtt-url" value="${esc(defaults.mqttUrl)}">
        </div>
        <div class="form-group">
          <label>MQTT User</label>
          <input type="text" id="setup-mqtt-user" value="${esc(defaults.mqttUser)}">
        </div>
        <div class="form-group">
          <label>MQTT Password</label>
          <input type="text" id="setup-mqtt-pass" value="${esc(defaults.mqttPass)}">
        </div>
        <div class="form-group">
          <label>Docker Image</label>
          <input type="text" id="setup-image" value="${esc(defaults.image)}">
        </div>
      </div>

      <div class="card">
        <h2>Install Command</h2>
        <div class="command-wrapper">
          <pre class="command-block" id="setup-command"></pre>
          <button class="copy-btn" id="setup-copy" title="Copy to clipboard">Copy</button>
        </div>
        <div id="setup-copied" style="display:none" class="alert-banner green">Copied to clipboard!</div>
      </div>
    `;

    function updateCommand() {
      const hostId = document.getElementById('setup-host-id').value || '<host-id>';
      const mqttUrl = document.getElementById('setup-mqtt-url').value;
      const mqttUser = document.getElementById('setup-mqtt-user').value;
      const mqttPass = document.getElementById('setup-mqtt-pass').value;
      const image = document.getElementById('setup-image').value;

      const cmd = [
        'docker run -d \\',
        '  --name insightd-agent \\',
        '  --restart unless-stopped \\',
        '  -v /var/run/docker.sock:/var/run/docker.sock:ro \\',
        '  -v /:/host:ro \\',
        `  -e INSIGHTD_HOST_ID=${hostId} \\`,
        `  -e INSIGHTD_MQTT_URL=${mqttUrl} \\`,
        mqttUser ? `  -e INSIGHTD_MQTT_USER=${mqttUser} \\` : null,
        mqttPass ? `  -e INSIGHTD_MQTT_PASS=${mqttPass} \\` : null,
        `  ${image}`,
      ].filter(Boolean).join('\n');

      document.getElementById('setup-command').textContent = cmd;
    }

    document.querySelectorAll('#setup-host-id, #setup-mqtt-url, #setup-mqtt-user, #setup-mqtt-pass, #setup-image')
      .forEach(el => el.addEventListener('input', updateCommand));
    updateCommand();

    document.getElementById('setup-copy').addEventListener('click', async () => {
      const cmd = document.getElementById('setup-command').textContent;
      await navigator.clipboard.writeText(cmd);
      const msg = document.getElementById('setup-copied');
      msg.style.display = '';
      setTimeout(() => { msg.style.display = 'none'; }, 2000);
    });
  }

  // --- Router ---
  async function route() {
    clearInterval(refreshTimer);
    const hash = location.hash || '#/';
    const parts = hash.slice(1).split('/').filter(Boolean);

    // Highlight active nav link
    document.querySelectorAll('nav a:not(.logo)').forEach(a => {
      const href = a.getAttribute('href');
      a.classList.toggle('active', href === '#/' + (parts[0] || ''));
    });

    try {
      if (parts[0] === 'hosts' && parts[1] && parts[2] === 'containers' && parts[3]) {
        await renderContainerDetail(decodeURIComponent(parts[1]), decodeURIComponent(parts[3]));
      } else if (parts[0] === 'hosts' && parts[1]) {
        await renderHostDetail(decodeURIComponent(parts[1]));
      } else if (parts[0] === 'hosts') {
        await renderHosts();
      } else if (parts[0] === 'alerts') {
        await renderAlerts();
      } else if (parts[0] === 'endpoints' && parts[1] === 'new') {
        await renderEndpointForm(null);
      } else if (parts[0] === 'endpoints' && parts[1] && parts[2] === 'edit') {
        await renderEndpointForm(parts[1]);
      } else if (parts[0] === 'endpoints' && parts[1]) {
        await renderEndpointDetail(parts[1]);
      } else if (parts[0] === 'endpoints') {
        await renderEndpoints();
      } else if (parts[0] === 'add-agent') {
        await renderAddAgent();
      } else if (parts[0] === 'settings') {
        await renderSettings();
      } else {
        await renderDashboard();
      }
    } catch (err) {
      app.innerHTML = `<div class="empty">Error loading data: ${esc(err.message)}</div>`;
    }

    // Auto-refresh (not for settings page)
    if (parts[0] !== 'settings' && parts[0] !== 'add-agent') {
      refreshTimer = setInterval(() => route(), 30000);
    }
  }

  // Check health to show/hide nav links
  api('/health').then(h => {
    if (h.authEnabled) {
      const navSettings = document.getElementById('nav-settings');
      if (navSettings) navSettings.style.display = '';
    }
    if (h.mode === 'hub') {
      const navAddAgent = document.getElementById('nav-add-agent');
      if (navAddAgent) navAddAgent.style.display = '';
    }
  }).catch(() => {});

  window.addEventListener('hashchange', route);
  route();
})();
