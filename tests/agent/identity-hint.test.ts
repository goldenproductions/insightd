import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const fs = require('fs');
const os = require('os');

import { collectIdentityHint } from '../../agent/src/collectors/identity-hint';

function mockReadFile(map: Record<string, string | Error>) {
  return mock.method(fs, 'readFileSync', (p: any) => {
    const key = String(p);
    const v = map[key];
    if (v === undefined) { const e: any = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
    if (v instanceof Error) throw v;
    return v;
  });
}

test('detects qemu via DMI sys_vendor and reads UUID', () => {
  mockReadFile({
    '/sys/class/dmi/id/sys_vendor': 'QEMU\n',
    '/sys/class/dmi/id/product_uuid': '12345678-1234-1234-1234-1234567890ab\n',
  });
  mock.method(os, 'hostname', () => 'qemu-vm');
  mock.method(os, 'networkInterfaces', () => ({
    eth0: [{ mac: 'bc:24:11:00:00:01', internal: false, family: 'IPv4', address: '10.0.0.10' }],
  }));

  const hint = collectIdentityHint();
  assert.equal(hint.virt_type, 'qemu');
  assert.equal(hint.system_uuid, '12345678-1234-1234-1234-1234567890ab');
  assert.equal(hint.hostname, 'qemu-vm');
  assert.equal(hint.primary_mac, 'bc:24:11:00:00:01');

  mock.restoreAll();
});

test('detects lxc via /proc/1/environ', () => {
  mockReadFile({
    '/proc/1/environ': 'PATH=/usr/bin\0container=lxc\0HOME=/root\0',
  });
  mock.method(os, 'hostname', () => 'web01');
  mock.method(os, 'networkInterfaces', () => ({
    eth0: [{ mac: 'bc:24:11:00:00:02', internal: false, family: 'IPv4', address: '10.0.0.11' }],
  }));

  const hint = collectIdentityHint();
  assert.equal(hint.virt_type, 'lxc');
  assert.equal(hint.system_uuid, null);
  assert.equal(hint.hostname, 'web01');
  assert.equal(hint.primary_mac, 'bc:24:11:00:00:02');

  mock.restoreAll();
});

test('detects bare metal when no signals', () => {
  mockReadFile({});
  mock.method(os, 'hostname', () => 'bare');
  mock.method(os, 'networkInterfaces', () => ({}));

  const hint = collectIdentityHint();
  assert.equal(hint.virt_type, 'bare');
  assert.equal(hint.system_uuid, null);
  assert.equal(hint.primary_mac, null);

  mock.restoreAll();
});

test('skips loopback and zero-MAC interfaces and docker bridges', () => {
  mockReadFile({});
  mock.method(os, 'hostname', () => 'h');
  mock.method(os, 'networkInterfaces', () => ({
    lo: [{ mac: '00:00:00:00:00:00', internal: true, family: 'IPv4', address: '127.0.0.1' }],
    docker0: [{ mac: '02:42:bc:24:11:00', internal: false, family: 'IPv4', address: '172.17.0.1' }],
    eth0: [{ mac: 'bc:24:11:00:00:03', internal: false, family: 'IPv4', address: '10.0.0.12' }],
  }));

  const hint = collectIdentityHint();
  assert.equal(hint.primary_mac, 'bc:24:11:00:00:03');

  mock.restoreAll();
});

test('honors INSIGHTD_HOST_ROOT for LXC detection (agent in docker on host LXC)', () => {
  // Container's /proc/1/environ doesn't have container=lxc (it's the agent
  // process), but the host LXC's /proc/1/environ does. Reading via /host
  // succeeds.
  mockReadFile({
    '/proc/1/environ': 'PATH=/usr/bin\0AGENT=insightd\0',           // agent container's PID 1
    '/host/proc/1/environ': 'container=lxc\0HOME=/root\0',          // host LXC's PID 1
    '/host/etc/hostname': 'AdGuard\n',                              // host LXC hostname
  });
  mock.method(os, 'hostname', () => 'docker-container-id-abc123');
  mock.method(os, 'networkInterfaces', () => ({}));

  const prev = process.env.INSIGHTD_HOST_ROOT;
  process.env.INSIGHTD_HOST_ROOT = '/host';
  try {
    const hint = collectIdentityHint();
    assert.equal(hint.virt_type, 'lxc');
    assert.equal(hint.hostname, 'AdGuard');
  } finally {
    if (prev === undefined) delete process.env.INSIGHTD_HOST_ROOT;
    else process.env.INSIGHTD_HOST_ROOT = prev;
    mock.restoreAll();
  }
});

test('honors INSIGHTD_HOST_ROOT for qemu UUID (agent in docker on host VM)', () => {
  mockReadFile({
    '/host/sys/class/dmi/id/sys_vendor': 'QEMU\n',
    '/host/sys/class/dmi/id/product_uuid': 'aabbccdd-eeff-0011-2233-445566778899\n',
    '/host/etc/hostname': 'n8n\n',
  });
  mock.method(os, 'hostname', () => 'docker-container-id-xyz');
  mock.method(os, 'networkInterfaces', () => ({}));

  const prev = process.env.INSIGHTD_HOST_ROOT;
  process.env.INSIGHTD_HOST_ROOT = '/host';
  try {
    const hint = collectIdentityHint();
    assert.equal(hint.virt_type, 'qemu');
    assert.equal(hint.system_uuid, 'aabbccdd-eeff-0011-2233-445566778899');
    assert.equal(hint.hostname, 'n8n');
  } finally {
    if (prev === undefined) delete process.env.INSIGHTD_HOST_ROOT;
    else process.env.INSIGHTD_HOST_ROOT = prev;
    mock.restoreAll();
  }
});
