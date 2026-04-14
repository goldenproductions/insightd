import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
const {
  colors,
  escapeHtml,
  linkTo,
  emailShell,
  hero,
  card,
  metricRow,
  badge,
  button,
  divider,
  mutedText,
  calloutBox,
  evidenceList,
  progressBar,
} = require('../../shared/mail/components');

describe('mail components', () => {
  describe('escapeHtml', () => {
    it('escapes HTML-unsafe characters', () => {
      assert.equal(escapeHtml('<script>"&\'</script>'), '&lt;script&gt;&quot;&amp;&#39;&lt;/script&gt;');
    });
    it('returns empty string for null/undefined', () => {
      assert.equal(escapeHtml(null), '');
      assert.equal(escapeHtml(undefined), '');
    });
    it('handles numbers', () => {
      assert.equal(escapeHtml(42), '42');
    });
  });

  describe('linkTo', () => {
    it('joins base and path without duplicate slashes', () => {
      assert.equal(linkTo('https://example.com/', '/foo'), 'https://example.com/foo');
      assert.equal(linkTo('https://example.com', 'foo'), 'https://example.com/foo');
    });
    it('returns undefined when baseUrl is empty', () => {
      assert.equal(linkTo('', '/foo'), undefined);
      assert.equal(linkTo(undefined, '/foo'), undefined);
    });
  });

  describe('emailShell', () => {
    it('produces a full HTML document', () => {
      const html = emailShell({ title: 'Hello', body: '<tr><td>body</td></tr>' });
      assert.match(html, /<!DOCTYPE html>/);
      assert.match(html, /<\/html>/);
      assert.match(html, /Hello/);
      assert.match(html, /<tr><td>body<\/td><\/tr>/);
    });
    it('omits <style> and <script> blocks entirely', () => {
      const html = emailShell({ title: 'Hi', body: '' });
      assert.ok(!/<style\b/i.test(html));
      assert.ok(!/<script\b/i.test(html));
    });
    it('includes the preheader when provided', () => {
      const html = emailShell({ title: 'T', body: '', preheader: 'Inbox preview text' });
      assert.match(html, /Inbox preview text/);
    });
  });

  describe('hero', () => {
    it('uses the expected severity color', () => {
      assert.match(hero({ severity: 'red', title: 'Bad' }), /#dc2626/);
      assert.match(hero({ severity: 'green', title: 'Good' }), /#059669/);
      assert.match(hero({ severity: 'yellow', title: 'Warn' }), /#d97706/);
    });
    it('renders title, eyebrow, subtitle', () => {
      const html = hero({ severity: 'red', eyebrow: 'Alert', title: 'It broke', subtitle: 'More details' });
      assert.match(html, /Alert/);
      assert.match(html, /It broke/);
      assert.match(html, /More details/);
    });
    it('escapes unsafe title characters', () => {
      const html = hero({ severity: 'red', title: '<script>' });
      assert.match(html, /&lt;script&gt;/);
      assert.ok(!/<script>/.test(html));
    });
  });

  describe('card', () => {
    it('renders the title when provided', () => {
      const html = card({ title: 'Details', children: '<div>inner</div>' });
      assert.match(html, /Details/);
      assert.match(html, /<div>inner<\/div>/);
    });
  });

  describe('metricRow', () => {
    it('renders label and value', () => {
      const html = metricRow({ label: 'CPU', value: '42%' });
      assert.match(html, /CPU/);
      assert.match(html, /42%/);
    });
    it('wraps label in link when href provided', () => {
      const html = metricRow({ label: 'nginx', value: 'up', href: 'https://example.com/x' });
      assert.match(html, /<a href="https:\/\/example\.com\/x"/);
    });
  });

  describe('badge', () => {
    it('renders text inline', () => {
      assert.match(badge({ text: 'Beta' }), /Beta/);
    });
    it('uses tone color when provided', () => {
      assert.match(badge({ text: 'Bad', tone: 'red' }), /#dc2626/);
    });
  });

  describe('button', () => {
    it('renders anchor with href and text', () => {
      const html = button({ href: 'https://example.com', text: 'Open' });
      assert.match(html, /<a href="https:\/\/example\.com"/);
      assert.match(html, /Open/);
    });
  });

  describe('evidenceList', () => {
    it('renders items as <li>', () => {
      const html = evidenceList(['one', 'two', 'three']);
      assert.match(html, /<li[^>]*>one<\/li>/);
      assert.match(html, /<li[^>]*>two<\/li>/);
      assert.match(html, /<li[^>]*>three<\/li>/);
    });
    it('returns empty string for empty array', () => {
      assert.equal(evidenceList([]), '');
    });
  });

  describe('progressBar', () => {
    it('clamps percent to [0,100]', () => {
      const hi = progressBar({ percent: 150, tone: 'red' });
      assert.match(hi, /width:100%/);
      const lo = progressBar({ percent: -20, tone: 'red' });
      assert.match(lo, /width:0%/);
    });
  });

  describe('calloutBox', () => {
    it('wraps children with severity-colored background', () => {
      const html = calloutBox({ children: 'Take action', tone: 'red' });
      assert.match(html, /Take action/);
      assert.match(html, /#dc2626/);
    });
  });

  describe('divider + mutedText', () => {
    it('divider is a styled spacer', () => {
      assert.match(divider(), /height:1px/);
    });
    it('mutedText wraps text with dim color', () => {
      const html = mutedText('subtle');
      assert.match(html, /subtle/);
      assert.match(html, /#6b7280/);
    });
  });

  describe('colors palette', () => {
    it('exposes the expected severity hexes', () => {
      assert.equal(colors.red, '#dc2626');
      assert.equal(colors.green, '#059669');
      assert.equal(colors.yellow, '#d97706');
    });
  });
});
