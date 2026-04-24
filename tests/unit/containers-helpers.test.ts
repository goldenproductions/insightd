import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
const {
  getContainerNamespace,
  getContainerDisplayName,
  splitContainerEntityId,
} = require('../../hub/src/web/frontend/src/lib/containers');

describe('getContainerNamespace', () => {
  it('returns null for Docker container names (no slash)', () => {
    assert.equal(getContainerNamespace('nginx'), null);
    assert.equal(getContainerNamespace('redis'), null);
  });

  it('returns namespace for k8s container names', () => {
    assert.equal(getContainerNamespace('kube-system/coredns-abc/coredns'), 'kube-system');
    assert.equal(getContainerNamespace('default/myapp-xyz/myapp'), 'default');
  });

  it('handles edge shapes safely', () => {
    assert.equal(getContainerNamespace(''), null);
    assert.equal(getContainerNamespace('/leading-slash'), null);
  });
});

describe('getContainerDisplayName', () => {
  it('returns the Docker container name unchanged', () => {
    assert.equal(getContainerDisplayName('nginx'), 'nginx');
  });

  it('strips the namespace prefix from k8s names', () => {
    assert.equal(getContainerDisplayName('kube-system/coredns-abc/coredns'), 'coredns-abc/coredns');
  });
});

describe('splitContainerEntityId', () => {
  it('splits "host/container" into parts', () => {
    assert.deepEqual(splitContainerEntityId('h1/nginx'), { hostId: 'h1', containerName: 'nginx' });
  });

  it('preserves inner slashes for k8s entity ids (5 segments)', () => {
    assert.deepEqual(
      splitContainerEntityId('h1/kube-system/coredns-abc/coredns'),
      { hostId: 'h1', containerName: 'kube-system/coredns-abc/coredns' },
    );
  });

  it('returns null for malformed ids', () => {
    assert.equal(splitContainerEntityId('nginx'), null);
    assert.equal(splitContainerEntityId('h1/'), null);
    assert.equal(splitContainerEntityId(''), null);
  });
});
