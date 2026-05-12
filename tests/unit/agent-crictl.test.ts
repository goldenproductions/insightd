// tests/unit/agent-crictl.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
const { viaCrictl, isCrictlAvailable } =
  require('../../agent/src/collectors/processes/crictl');

describe('viaCrictl', () => {
  it('returns empty map when runtime is not k8s', async () => {
    const m = await viaCrictl({ runtime: 'docker' } as any);
    assert.equal(m.size, 0);
  });

  it('returns empty map when binary unavailable, logs once', async () => {
    const m = await viaCrictl({
      runtime: 'kubernetes',
      crictlAvailable: false,
      bootTimeMs: 0, argvMaxBytes: 4096,
    } as any);
    assert.equal(m.size, 0);
  });

  it('isCrictlAvailable returns true when which() resolves', async () => {
    const v = await isCrictlAvailable({ whichSync: () => '/usr/bin/crictl' });
    assert.equal(v, true);
  });

  it('isCrictlAvailable returns false when which() throws', async () => {
    const v = await isCrictlAvailable({ whichSync: () => { throw new Error('not found'); } });
    assert.equal(v, false);
  });
});
