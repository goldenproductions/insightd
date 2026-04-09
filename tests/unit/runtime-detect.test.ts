import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
const fs = require('fs');

function loadDetect(): { detectRuntime: () => string } {
  delete require.cache[require.resolve('../../agent/src/runtime/detect')];
  return require('../../agent/src/runtime/detect');
}

describe('detectRuntime', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.KUBERNETES_SERVICE_HOST;
    delete process.env.KUBERNETES_SERVICE_HOST;
  });

  afterEach(() => {
    if (savedEnv !== undefined) process.env.KUBERNETES_SERVICE_HOST = savedEnv;
    else delete process.env.KUBERNETES_SERVICE_HOST;
    mock.restoreAll();
  });

  it('returns "kubernetes" when KUBERNETES_SERVICE_HOST is set (running in-cluster)', () => {
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1';
    const { detectRuntime } = loadDetect();
    assert.equal(detectRuntime(), 'kubernetes');
  });

  it('returns "containerd" when k3s containerd socket exists', () => {
    mock.method(fs, 'existsSync', (p: string) => p === '/run/k3s/containerd/containerd.sock');
    const { detectRuntime } = loadDetect();
    assert.equal(detectRuntime(), 'containerd');
  });

  it('returns "containerd" when standard containerd socket exists', () => {
    mock.method(fs, 'existsSync', (p: string) => p === '/run/containerd/containerd.sock');
    const { detectRuntime } = loadDetect();
    assert.equal(detectRuntime(), 'containerd');
  });

  it('returns "docker" when only docker socket exists', () => {
    mock.method(fs, 'existsSync', (p: string) => p === '/var/run/docker.sock');
    const { detectRuntime } = loadDetect();
    assert.equal(detectRuntime(), 'docker');
  });

  it('falls back to "docker" when no sockets are present', () => {
    mock.method(fs, 'existsSync', () => false);
    const { detectRuntime } = loadDetect();
    assert.equal(detectRuntime(), 'docker');
  });

  it('prefers containerd over docker when both are present', () => {
    mock.method(fs, 'existsSync', (p: string) =>
      p === '/run/k3s/containerd/containerd.sock' || p === '/var/run/docker.sock'
    );
    const { detectRuntime } = loadDetect();
    assert.equal(detectRuntime(), 'containerd');
  });

  it('treats fs.existsSync errors as missing (skips that probe)', () => {
    mock.method(fs, 'existsSync', (p: string) => {
      if (p === '/run/k3s/containerd/containerd.sock') throw new Error('EACCES');
      return p === '/var/run/docker.sock';
    });
    const { detectRuntime } = loadDetect();
    assert.equal(detectRuntime(), 'docker');
  });
});
