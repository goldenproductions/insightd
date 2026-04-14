import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
const { renderHtml, renderPlainText } = require('../../src/digest/template');
const { GREEN_DIGEST, RED_DIGEST } = require('../helpers/fixtures');

describe('renderHtml', () => {
  it('produces valid HTML', () => {
    const html = renderHtml(GREEN_DIGEST);
    assert.match(html, /<!DOCTYPE html>/);
    assert.match(html, /<\/html>/);
  });

  it('uses only inline styles (no <style> or <script> blocks)', () => {
    const html = renderHtml(GREEN_DIGEST);
    assert.ok(!/<style\b/i.test(html), '<style> blocks should be absent in email HTML');
    assert.ok(!/<script\b/i.test(html), '<script> blocks should be absent in email HTML');
  });

  it('shows green severity color for green digest', () => {
    const html = renderHtml(GREEN_DIGEST);
    assert.match(html, /#059669/);
  });

  it('shows red severity color for red digest', () => {
    const html = renderHtml(RED_DIGEST);
    assert.match(html, /#dc2626/);
  });

  it('renders a calm-week headline when nothing is flagged', () => {
    const html = renderHtml(GREEN_DIGEST);
    assert.match(html, /A calm week/);
  });

  it('renders an attention headline when things are flagged', () => {
    const html = renderHtml(RED_DIGEST);
    assert.match(html, /(Things needed attention|A few things to look at)/);
  });

  it('includes week number in the hero eyebrow', () => {
    const html = renderHtml(GREEN_DIGEST);
    assert.match(html, /Week 14/);
  });

  it('renders the containers card and container names', () => {
    const html = renderHtml(GREEN_DIGEST);
    assert.match(html, /Containers/);
    assert.match(html, /nginx/);
    assert.match(html, /redis/);
  });

  it('shows uptime percentages in container rows', () => {
    const html = renderHtml(RED_DIGEST);
    assert.match(html, /75%/);
    assert.match(html, /96%/);
  });

  it('shows restart counts when present', () => {
    const html = renderHtml(RED_DIGEST);
    assert.match(html, /3 restarts/);
    assert.match(html, /2 restarts/);
  });

  it('shows Insights card when trends exist', () => {
    const html = renderHtml(RED_DIGEST);
    assert.match(html, /Insights/);
    assert.match(html, /RAM/);
    assert.match(html, /25%/);
  });

  it('omits Insights card when no trends or anomalies', () => {
    const html = renderHtml(GREEN_DIGEST);
    assert.ok(!/>Insights</.test(html));
  });

  it('shows disk usage card and percent for warnings', () => {
    const html = renderHtml(RED_DIGEST);
    assert.match(html, /Disk usage/);
    assert.match(html, /90%/);
  });

  it('shows updates card when updates available', () => {
    const html = renderHtml(RED_DIGEST);
    // The card title is "Updates available (N)" — matches only the section header.
    assert.match(html, /Updates available \(1\)/);
    assert.match(html, /nginx:alpine/);
  });

  it('omits updates card when no updates', () => {
    const html = renderHtml(GREEN_DIGEST);
    // Summary row still reads "Updates available: 0"; the standalone card is what we want gone.
    assert.ok(!/Updates available \(/.test(html));
    assert.ok(!/nginx:alpine/.test(html));
  });

  it('shows Needs attention card when alerts were triggered', () => {
    const digest = { ...RED_DIGEST, triggeredAlertsThisWeek: [
      { type: 'container_down', target: 'nginx', hostId: 'host-1', message: 'nginx is down', triggeredAt: '2026-04-10 10:00:00', resolvedAt: '2026-04-10 10:30:00', durationMinutes: 30, reminderCount: 0 },
    ] };
    const html = renderHtml(digest);
    assert.match(html, /Needs attention/);
    assert.match(html, /nginx is down/);
  });

  it('omits Needs attention card when no alerts', () => {
    const digest = { ...RED_DIGEST, triggeredAlertsThisWeek: [] };
    const html = renderHtml(digest);
    assert.ok(!/Needs attention/.test(html));
  });

  it('shows anomalies in the Insights card when present', () => {
    const digest = { ...GREEN_DIGEST, anomaliesThisWeek: [
      { entityType: 'host', entityId: 'host-1', metric: 'cpu_percent', bucketStart: '2026-04-12 12:00:00', robustZ: 12.5 },
    ] };
    const html = renderHtml(digest);
    assert.match(html, /Anomalies detected/);
    assert.match(html, /host-1/);
    assert.match(html, /z=12\.5/);
  });

  it('groups hosts when hostGroups contains named groups', () => {
    const digest = {
      ...GREEN_DIGEST,
      hostMetrics: [
        { hostId: 'prod-1', avgCpu: 25, maxCpu: 40, avgMemUsedMb: 1024, maxMemUsedMb: 2048, memTotalMb: 4096, avgLoad: 1.2, maxLoad: 2.0 },
        { hostId: 'dev-1', avgCpu: 5, maxCpu: 10, avgMemUsedMb: 512, maxMemUsedMb: 1024, memTotalMb: 2048, avgLoad: 0.3, maxLoad: 0.5 },
      ],
      hostGroups: [
        { group: 'production', hostIds: ['prod-1'] },
        { group: 'development', hostIds: ['dev-1'] },
      ],
    };
    const html = renderHtml(digest);
    assert.match(html, /PRODUCTION|production/);
    assert.match(html, /DEVELOPMENT|development/);
  });

  it('renders Open dashboard button when baseUrl is provided', () => {
    const html = renderHtml(GREEN_DIGEST, 'https://insightd.example.com');
    assert.match(html, /Open Insightd dashboard/);
    assert.match(html, /insightd\.example\.com/);
  });

  it('omits Open dashboard button when baseUrl is empty', () => {
    const html = renderHtml(GREEN_DIGEST, '');
    assert.ok(!/Open Insightd dashboard/.test(html));
  });
});

describe('renderPlainText', () => {
  it('includes Insightd header and week number', () => {
    const text = renderPlainText(GREEN_DIGEST);
    assert.match(text, /Insightd · Week 14/);
  });

  it('shows uptime percentage', () => {
    const text = renderPlainText(GREEN_DIGEST);
    assert.match(text, /uptime:.*100%/i);
  });

  it('shows zero restarts', () => {
    const text = renderPlainText(GREEN_DIGEST);
    assert.match(text, /Restarts:\s+0/);
  });

  it('shows restarted container names', () => {
    const text = renderPlainText(RED_DIGEST);
    assert.match(text, /nginx/);
    assert.match(text, /redis/);
  });

  it('shows resource trends', () => {
    const text = renderPlainText(RED_DIGEST);
    assert.match(text, /postgres/i);
    assert.match(text, /RAM/);
  });

  it('shows disk warnings', () => {
    const text = renderPlainText(RED_DIGEST);
    assert.match(text, /90%/);
  });

  it('shows summary line', () => {
    const text = renderPlainText(GREEN_DIGEST);
    assert.match(text, /No critical issues/);
  });

  it('shows Needs attention section when alerts present', () => {
    const digest = { ...RED_DIGEST, triggeredAlertsThisWeek: [
      { type: 'container_down', target: 'nginx', hostId: 'host-1', message: 'nginx is down', triggeredAt: '2026-04-10 10:00:00', resolvedAt: null, durationMinutes: 120, reminderCount: 2 },
    ] };
    const text = renderPlainText(digest);
    assert.match(text, /Needs attention/);
    assert.match(text, /nginx is down/);
    assert.match(text, /active for 2h/);
  });

  it('shows Open dashboard link when baseUrl is provided', () => {
    const text = renderPlainText(GREEN_DIGEST, 'https://insightd.example.com');
    assert.match(text, /Open dashboard.*insightd\.example\.com/);
  });
});
