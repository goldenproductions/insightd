import { test } from 'node:test';
import assert from 'node:assert/strict';
const { subjectFor, renderAlertHtml } = require('../shared/mail/alert-template');
const { renderAftermathText, aftermathSubject } = require('../shared/mail/aftermath-template');

test('subject carries severity badge', () => {
  assert.match(subjectFor({ type: 'host_offline', target: 'system', message: 'down', severity: 'critical' }), /^\[CRITICAL\]/);
  assert.match(subjectFor({ type: 'restart_loop', target: 'redis', message: 'flap', severity: 'warning' }), /^\[WARNING\]/);
});

test('subject without severity still works (back-compat)', () => {
  const subj = subjectFor({ type: 'host_offline', target: 'system', message: 'down' });
  assert.ok(typeof subj === 'string');
  assert.ok(subj.length > 0);
});

test('html footer contains mute link with token', () => {
  const html = renderAlertHtml({ type: 'restart_loop', target: 'redis', message: 'flap', severity: 'warning' }, { baseUrl: 'https://insightd.local', muteToken: 'tok123' });
  assert.match(html, /mute/i);
  assert.match(html, /tok123/);
});

test('aftermath subject lists counts', () => {
  const summary = {
    parent: { alert_type: 'host_offline', host_id: 'h1', target: 'system' },
    durationMinutes: 47, stillFiring: [{ alert_type: 'container_down', target: 'pg', host_id: 'h1', resolved: false }],
    cleared: [{ alert_type: 'container_down', target: 'nginx', host_id: 'h1', resolved: true }],
  };
  const subj = aftermathSubject(summary);
  assert.match(subj, /h1/);
  assert.match(subj, /1.*cleared/);
  assert.match(subj, /1.*still/);
});

test('aftermath text lists each child', () => {
  const summary = {
    parent: { alert_type: 'host_offline', host_id: 'h1', target: 'system' },
    durationMinutes: 47,
    stillFiring: [{ alert_type: 'container_down', target: 'postgres', host_id: 'h1', resolved: false }],
    cleared: [
      { alert_type: 'container_down', target: 'nginx', host_id: 'h1', resolved: true },
      { alert_type: 'container_down', target: 'redis', host_id: 'h1', resolved: true },
    ],
  };
  const text = renderAftermathText(summary, '');
  assert.match(text, /postgres/);
  assert.match(text, /nginx/);
  assert.match(text, /redis/);
  assert.match(text, /47 minutes/);
});
