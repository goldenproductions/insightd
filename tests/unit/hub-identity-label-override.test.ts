import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractProxmoxLink } from '../../hub/src/identity/labelExtractor';

test('parses node/vmid from label', () => {
  assert.deepEqual(extractProxmoxLink({ 'insightd.proxmox.guest': 'pve1/108' }),
    { node: 'pve1', vmid: 108 });
});

test('returns null when label missing', () => {
  assert.equal(extractProxmoxLink({}), null);
  assert.equal(extractProxmoxLink(null as any), null);
  assert.equal(extractProxmoxLink(undefined as any), null);
});

test('returns null when value malformed', () => {
  assert.equal(extractProxmoxLink({ 'insightd.proxmox.guest': 'no-slash' }), null);
  assert.equal(extractProxmoxLink({ 'insightd.proxmox.guest': 'pve/notnum' }), null);
});
