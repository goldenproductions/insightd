import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
const { validateIdentifier, validateBrokerUrl, validateImage } = require('../../hub/src/web/frontend/src/pages/add-agent/validation');

describe('validateIdentifier', () => {
  it('accepts plain ascii names', () => {
    assert.equal(validateIdentifier('nas-01'), null);
    assert.equal(validateIdentifier('proxmox.lab'), null);
    assert.equal(validateIdentifier('node_1'), null);
  });
  it('rejects empty', () => assert.match(validateIdentifier('') ?? '', /required/i));
  it('rejects shell metacharacters', () => {
    for (const bad of ['nas;rm', 'nas`whoami`', 'nas$x', 'nas|x', 'nas x', 'nas\nfoo', 'nas&x']) {
      assert.notEqual(validateIdentifier(bad), null, `'${bad}' should be rejected`);
    }
  });
  it('rejects > 63 chars', () => assert.notEqual(validateIdentifier('a'.repeat(64)), null));
});

describe('validateBrokerUrl', () => {
  it('accepts mqtt:// and mqtts://', () => {
    assert.equal(validateBrokerUrl('mqtt://hub:1883'), null);
    assert.equal(validateBrokerUrl('mqtts://broker.example.com:8883'), null);
  });
  it('treats empty as valid (uses default)', () => assert.equal(validateBrokerUrl(''), null));
  it('rejects non-mqtt scheme', () => assert.notEqual(validateBrokerUrl('http://x'), null));
  it('rejects shell metacharacters', () => {
    for (const bad of ['mqtt://h ;x', 'mqtt://`x`', 'mqtt://h$x']) {
      assert.notEqual(validateBrokerUrl(bad), null);
    }
  });
});

describe('validateImage', () => {
  it('accepts standard refs', () => {
    assert.equal(validateImage('andreas404/insightd-agent:latest'), null);
    assert.equal(validateImage('ghcr.io/foo/bar:v1.2.3@sha256:abc'), null);
  });
  it('treats empty as valid', () => assert.equal(validateImage(''), null));
  it('rejects shell metacharacters', () => {
    for (const bad of ['img;x', 'img`x`', 'img$x', 'img |x']) {
      assert.notEqual(validateImage(bad), null);
    }
  });
});
