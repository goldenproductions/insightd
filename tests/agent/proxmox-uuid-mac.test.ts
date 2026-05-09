import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQemuSmbios, parseLxcNet0Hwaddr } from '../../agent/src/runtime/proxmox';

test('parseQemuSmbios extracts uuid', () => {
  const raw = 'uuid=12345678-1234-1234-1234-1234567890ab,manufacturer=ABC';
  assert.equal(parseQemuSmbios(raw), '12345678-1234-1234-1234-1234567890ab');
});

test('parseQemuSmbios returns null when no uuid', () => {
  assert.equal(parseQemuSmbios('manufacturer=ABC'), null);
  assert.equal(parseQemuSmbios(''), null);
  assert.equal(parseQemuSmbios(undefined), null);
});

test('parseLxcNet0Hwaddr extracts hwaddr (case-insensitive, lowercased)', () => {
  const raw = 'name=eth0,bridge=vmbr0,hwaddr=BC:24:11:00:00:01,ip=dhcp';
  assert.equal(parseLxcNet0Hwaddr(raw), 'bc:24:11:00:00:01');
});

test('parseLxcNet0Hwaddr returns null when missing', () => {
  assert.equal(parseLxcNet0Hwaddr('name=eth0,bridge=vmbr0'), null);
  assert.equal(parseLxcNet0Hwaddr(''), null);
});
