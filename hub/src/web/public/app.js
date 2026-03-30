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
