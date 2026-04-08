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

  it('shows green header for green digest', () => {
    const html = renderHtml(GREEN_DIGEST);
    assert.match(html, /#059669/); // green color
    assert.match(html, /🟢/);
  });

  it('shows red header for red digest', () => {
    const html = renderHtml(RED_DIGEST);
    assert.match(html, /#dc2626/); // red color
    assert.match(html, /🔴/);
  });

  it('includes week number', () => {
    const html = renderHtml(GREEN_DIGEST);
    assert.match(html, /Week 14/);
  });

  it('shows container rows', () => {
    const html = renderHtml(GREEN_DIGEST);
    assert.match(html, /nginx/);
    assert.match(html, /redis/);
  });

  it('shows uptime percentages', () => {
    const html = renderHtml(RED_DIGEST);
    assert.match(html, /75%/);
    assert.match(html, /96%/);
  });

  it('shows restart counts when present', () => {
    const html = renderHtml(RED_DIGEST);
    assert.match(html, /3 restarts/);
    assert.match(html, /2 restarts/);
  });

  it('shows trends section when trends exist', () => {
    const html = renderHtml(RED_DIGEST);
    assert.match(html, /Resource Trends/);
    assert.match(html, /RAM/);
    assert.match(html, /25%/);
  });

  it('omits trends section when empty', () => {
    const html = renderHtml(GREEN_DIGEST);
    assert.ok(!html.includes('Resource Trends'));
  });

  it('shows disk warning emoji when over threshold', () => {
    const html = renderHtml(RED_DIGEST);
    assert.match(html, /⚠️/);
  });

  it('shows updates section when updates available', () => {
    const html = renderHtml(RED_DIGEST);
    assert.match(html, /Updates Available/);
    assert.match(html, /nginx:alpine/);
  });

  it('omits updates section when no updates', () => {
    const html = renderHtml(GREEN_DIGEST);
    assert.ok(!html.includes('Updates Available'));
  });
});

describe('renderPlainText', () => {
  it('includes status icon and week number', () => {
    const text = renderPlainText(GREEN_DIGEST);
    assert.match(text, /🟢 Insightd — Week 14/);
  });

  it('shows uptime percentage', () => {
    const text = renderPlainText(GREEN_DIGEST);
    assert.match(text, /Uptime:.*100%/);
  });

  it('shows zero restarts', () => {
    const text = renderPlainText(GREEN_DIGEST);
    assert.match(text, /Restarts:.*0/);
  });

  it('shows restart container names', () => {
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
    assert.match(text, /⚠️/);
    assert.match(text, /90%/);
  });

  it('shows summary line', () => {
    const text = renderPlainText(GREEN_DIGEST);
    assert.match(text, /No critical issues/);
  });
});
