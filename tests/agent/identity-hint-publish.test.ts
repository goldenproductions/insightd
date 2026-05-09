import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIdentityHintTopic, buildIdentityHintPayload } from '../../agent/src/mqtt';

test('builds correct identity-hint topic per host', () => {
  assert.equal(buildIdentityHintTopic('proxmox-01'), 'insightd/proxmox-01/identity-hint');
});

test('payload omits virt_type=bare', () => {
  const payload = buildIdentityHintPayload({
    virt_type: 'bare',
    system_uuid: null,
    hostname: 'h',
    primary_mac: null,
  });
  assert.equal(payload, null);
});

test('payload includes hint when virt_type is qemu', () => {
  const payload = buildIdentityHintPayload({
    virt_type: 'qemu',
    system_uuid: 'aaaa-bbbb',
    hostname: 'h',
    primary_mac: 'bc:24:11:00:00:01',
  });
  assert.deepEqual(JSON.parse(payload!), {
    virt_type: 'qemu',
    system_uuid: 'aaaa-bbbb',
    hostname: 'h',
    primary_mac: 'bc:24:11:00:00:01',
  });
});
