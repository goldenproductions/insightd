import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
const child_process = require('child_process');

function loadCollector(): { collectGpu: () => any } {
  delete require.cache[require.resolve('../../agent/src/collectors/gpu')];
  return require('../../agent/src/collectors/gpu');
}

describe('collectGpu', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('returns null when nvidia-smi is unavailable', () => {
    mock.method(child_process, 'execSync', () => {
      throw new Error('nvidia-smi: command not found');
    });
    const { collectGpu } = loadCollector();
    assert.equal(collectGpu(), null);
  });

  it('returns null when nvidia-smi outputs nothing', () => {
    mock.method(child_process, 'execSync', () => String(''));
    const { collectGpu } = loadCollector();
    assert.equal(collectGpu(), null);
  });

  it('parses single-GPU CSV output', () => {
    mock.method(child_process, 'execSync', () =>
      String('NVIDIA GeForce RTX 3080, 45, 4096, 10240, 65')
    );
    const { collectGpu } = loadCollector();
    const result = collectGpu();
    assert.ok(result);
    assert.equal(result.gpus.length, 1);
    assert.deepEqual(result.gpus[0], {
      name: 'NVIDIA GeForce RTX 3080',
      utilizationPercent: 45,
      memoryUsedMb: 4096,
      memoryTotalMb: 10240,
      temperatureCelsius: 65,
    });
  });

  it('parses multi-GPU CSV output', () => {
    mock.method(child_process, 'execSync', () => String(
      'NVIDIA A100, 80, 30000, 40960, 70\n' +
      'NVIDIA A100, 60, 20000, 40960, 65'
    ));
    const { collectGpu } = loadCollector();
    const result = collectGpu();
    assert.equal(result.gpus.length, 2);
    assert.equal(result.gpus[0].utilizationPercent, 80);
    assert.equal(result.gpus[1].utilizationPercent, 60);
  });

  it('coerces malformed numeric fields to 0 (or null for temp)', () => {
    mock.method(child_process, 'execSync', () =>
      String('Unknown GPU, N/A, N/A, N/A, N/A')
    );
    const { collectGpu } = loadCollector();
    const result = collectGpu();
    assert.equal(result.gpus[0].name, 'Unknown GPU');
    assert.equal(result.gpus[0].utilizationPercent, 0);
    assert.equal(result.gpus[0].memoryUsedMb, 0);
    assert.equal(result.gpus[0].memoryTotalMb, 0);
    assert.equal(result.gpus[0].temperatureCelsius, null);
  });
});
