interface ChildSummary {
  alert_type: string;
  host_id: string;
  target: string;
  resolved: boolean;
}

interface AftermathSummary {
  parent: { alert_type: string; host_id: string; target: string };
  durationMinutes: number;
  stillFiring: ChildSummary[];
  cleared: ChildSummary[];
}

function aftermathSubject(s: AftermathSummary): string {
  return `[RESOLVED] ${s.parent.alert_type} on ${s.parent.host_id} — ${s.cleared.length} cleared, ${s.stillFiring.length} still firing`;
}

function fmtList(items: ChildSummary[]): string {
  if (items.length === 0) return '  (none)';
  return items.map(i => `  • ${i.alert_type}: ${i.target}`).join('\n');
}

function renderAftermathText(s: AftermathSummary, baseUrl: string): string {
  return [
    `Root cause resolved: ${s.parent.alert_type} on ${s.parent.host_id}.`,
    `Duration: ${s.durationMinutes} minutes.`,
    '',
    'Still firing on this scope:',
    fmtList(s.stillFiring),
    '',
    'Cleared in parallel:',
    fmtList(s.cleared),
    '',
    baseUrl ? `Details: ${baseUrl}/hosts/${encodeURIComponent(s.parent.host_id)}` : '',
  ].join('\n').trim();
}

function liHtml(items: ChildSummary[]): string {
  if (items.length === 0) return '<li><em>none</em></li>';
  return items.map(i => `<li><b>${i.alert_type}:</b> ${i.target}</li>`).join('');
}

function renderAftermathHtml(s: AftermathSummary, baseUrl: string): string {
  return `
    <h2>Root cause resolved</h2>
    <p>${s.parent.alert_type} on <b>${s.parent.host_id}</b> cleared after ${s.durationMinutes} minutes.</p>
    <h3>Still firing</h3><ul>${liHtml(s.stillFiring)}</ul>
    <h3>Cleared in parallel</h3><ul>${liHtml(s.cleared)}</ul>
    ${baseUrl ? `<p><a href="${baseUrl}/hosts/${encodeURIComponent(s.parent.host_id)}">View host</a></p>` : ''}
  `;
}

module.exports = { aftermathSubject, renderAftermathText, renderAftermathHtml };
