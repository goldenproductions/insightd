import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

function loadVersionCheck(): any {
  delete require.cache[require.resolve('../../hub/src/version-check')];
  delete require.cache[require.resolve('../../hub/src/config')];
  return require('../../hub/src/version-check');
}

function mockFetch(impl: (url: string) => Promise<any>): void {
  (globalThis as any).fetch = impl as any;
}

function jsonResponse(data: any, ok = true, status = 200): any {
  return {
    ok,
    status,
    json: async () => data,
  };
}

describe('version-check', () => {
  let realFetch: any;

  beforeEach(() => {
    realFetch = (globalThis as any).fetch;
  });

  afterEach(() => {
    (globalThis as any).fetch = realFetch;
    mock.restoreAll();
  });

  describe('getVersionInfo', () => {
    it('returns the current version with null latest before any check', () => {
      const vc = loadVersionCheck();
      const info = vc.getVersionInfo();
      assert.equal(typeof info.currentVersion, 'string');
      assert.equal(info.latestHubVersion, null);
      assert.equal(info.latestAgentVersion, null);
      assert.equal(info.hubUpdateAvailable, false);
      assert.equal(info.checkedAt, null);
      // Backwards-compat fields
      assert.equal(info.latestVersion, null);
      assert.equal(info.updateAvailable, false);
    });
  });

  describe('checkForUpdates', () => {
    it('extracts the highest semver tag from the response', async () => {
      mockFetch(async (url: string) => {
        if (url.includes('insightd-hub')) {
          return jsonResponse({ results: [
            { name: 'latest' },
            { name: '0.5.0' },
            { name: '0.10.2' },
            { name: '0.10.0' },
            { name: 'rc-1' },
          ] });
        }
        return jsonResponse({ results: [{ name: '0.7.1' }] });
      });

      const vc = loadVersionCheck();
      await vc.checkForUpdates();
      const info = vc.getVersionInfo();
      assert.equal(info.latestHubVersion, '0.10.2');
      assert.equal(info.latestAgentVersion, '0.7.1');
      assert.ok(info.checkedAt);
    });

    it('sets hubUpdateAvailable when latest differs from current', async () => {
      mockFetch(async () => jsonResponse({ results: [{ name: '99.99.99' }] }));
      const vc = loadVersionCheck();
      await vc.checkForUpdates();
      const info = vc.getVersionInfo();
      assert.equal(info.hubUpdateAvailable, true);
      assert.equal(info.updateAvailable, true);
    });

    it('handles empty tag list (no semver releases yet)', async () => {
      mockFetch(async () => jsonResponse({ results: [{ name: 'latest' }, { name: 'rc-1' }] }));
      const vc = loadVersionCheck();
      await vc.checkForUpdates();
      const info = vc.getVersionInfo();
      assert.equal(info.latestHubVersion, null);
      assert.equal(info.hubUpdateAvailable, false);
    });

    it('handles non-OK responses gracefully', async () => {
      mockFetch(async () => jsonResponse(null, false, 500));
      const vc = loadVersionCheck();
      await vc.checkForUpdates();
      // Both stay null
      const info = vc.getVersionInfo();
      assert.equal(info.latestHubVersion, null);
      assert.equal(info.latestAgentVersion, null);
    });

    it('handles fetch rejection without throwing', async () => {
      mockFetch(async () => { throw new Error('network down'); });
      const vc = loadVersionCheck();
      await assert.doesNotReject(() => vc.checkForUpdates());
      const info = vc.getVersionInfo();
      assert.equal(info.latestHubVersion, null);
    });

    it('handles malformed response (missing results array)', async () => {
      mockFetch(async () => jsonResponse({}));
      const vc = loadVersionCheck();
      await vc.checkForUpdates();
      const info = vc.getVersionInfo();
      assert.equal(info.latestHubVersion, null);
    });
  });
});
