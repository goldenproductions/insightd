(function () {
  const $ = (sel) => document.querySelector(sel);
  const app = $('#app');
  let refreshTimer = null;

  // --- API ---
  async function api(path) {
    const res = await fetch(`/api${path}`);
    if (!res.ok) throw new Error(`API ${res.status}`);
    return res.json();
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
  async function renderDashboard() {
    const data = await api('/dashboard');
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

  async function renderHostDetail(hostId) {
    const data = await api(`/hosts/${encodeURIComponent(hostId)}`);
    if (!data || data.error) {
      app.innerHTML = `<a class="back" href="#/hosts">&larr; Back</a><div class="empty">Host not found</div>`;
      return;
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

    app.innerHTML = `
      <a class="back" href="#/hosts">&larr; Back to hosts</a>
      <div class="section-title">${statusDot(data.is_online ? 'online' : 'offline')} ${esc(data.host_id)}</div>

      ${hostMetricsCard}

      <div class="card">
        <h2>Containers (${data.containers.length})</h2>
        ${data.containers.length > 0 ? tableWrap(`<table>
          <thead><tr><th>Name</th><th>Status</th><th>CPU</th><th>Memory</th><th>Restarts</th></tr></thead>
          <tbody>${containerRows}</tbody>
        </table>`) : '<div class="empty">No containers</div>'}
      </div>

      <div class="card">
        <h2>Disk Usage</h2>
        ${data.disk.length > 0 ? tableWrap(`<table>
          <thead><tr><th>Mount</th><th>Usage</th><th>Percent</th></tr></thead>
          <tbody>${diskRows}</tbody>
        </table>`) : '<div class="empty">No disk data</div>'}
      </div>

      ${data.alerts.length > 0 ? `<div class="card">
        <h2>Active Alerts (${data.alerts.length})</h2>
        ${tableWrap(`<table>
          <thead><tr><th>Type</th><th>Target</th><th>Triggered</th><th>Notifications</th></tr></thead>
          <tbody>${alertRows}</tbody>
        </table>`)}
      </div>` : ''}

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
        <h2>History (${history.length} snapshots)</h2>
        ${historyRows ? tableWrap(`<table>
          <thead><tr><th>Time</th><th>Status</th><th>CPU</th><th>Memory</th><th>Restarts</th></tr></thead>
          <tbody>${historyRows}</tbody>
        </table>`) : '<div class="empty">No history data</div>'}
      </div>

      <div class="refresh-info">Auto-refreshes every 30s</div>
    `;
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
      } else {
        await renderDashboard();
      }
    } catch (err) {
      app.innerHTML = `<div class="empty">Error loading data: ${esc(err.message)}</div>`;
    }

    // Auto-refresh
    refreshTimer = setInterval(() => route(), 30000);
  }

  window.addEventListener('hashchange', route);
  route();
})();
