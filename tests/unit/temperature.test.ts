import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs = require('fs');
import path = require('path');
import os = require('os');

function loadCollector(): { collectTemperature: (config: any) => any } {
  delete require.cache[require.resolve('../../agent/src/collectors/temperature')];
  return require('../../agent/src/collectors/temperature');
}

function writeThermalZone(root: string, idx: number, type: string, milliC: number): void {
  const dir = path.join(root, `sys/class/thermal/thermal_zone${idx}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'type'), type + '\n');
  fs.writeFileSync(path.join(dir, 'temp'), String(milliC) + '\n');
}

function writeHwmon(root: string, idx: number, name: string, sensors: Array<{ tempIdx: number; milliC: number; label?: string }>): void {
  const dir = path.join(root, `sys/class/hwmon/hwmon${idx}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'name'), name + '\n');
  for (const s of sensors) {
    fs.writeFileSync(path.join(dir, `temp${s.tempIdx}_input`), String(s.milliC) + '\n');
    if (s.label) fs.writeFileSync(path.join(dir, `temp${s.tempIdx}_label`), s.label + '\n');
  }
}

describe('collectTemperature', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'insightd-temp-'));
    // Always create the parent dirs so readdirSync doesn't throw before we add zones
    fs.mkdirSync(path.join(tmpRoot, 'sys/class/thermal'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'sys/class/hwmon'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('reads thermal zones (millicelsius → celsius with 1 decimal)', () => {
    // 45123 millicelsius reads as 45.1 °C (the source rounds to 1 decimal via /100/10)
    writeThermalZone(tmpRoot, 0, 'cpu-thermal', 45100);
    writeThermalZone(tmpRoot, 1, 'gpu-thermal', 60500);

    const { collectTemperature } = loadCollector();
    const result = collectTemperature({ hostRoot: tmpRoot });
    assert.ok(result);
    assert.equal(result.sensors.length, 2);
    const cpu = result.sensors.find((s: any) => s.name === 'cpu-thermal');
    const gpu = result.sensors.find((s: any) => s.name === 'gpu-thermal');
    assert.ok(cpu && Math.abs(cpu.temperatureCelsius - 45.1) < 0.5);
    assert.ok(gpu && Math.abs(gpu.temperatureCelsius - 60.5) < 0.5);
  });

  it('reads hwmon sensors with labels', () => {
    writeHwmon(tmpRoot, 0, 'k10temp', [
      { tempIdx: 1, milliC: 55000, label: 'Tctl' },
      { tempIdx: 2, milliC: 50000, label: 'Tdie' },
    ]);

    const { collectTemperature } = loadCollector();
    const result = collectTemperature({ hostRoot: tmpRoot });
    assert.ok(result);
    assert.equal(result.sensors.length, 2);
    assert.ok(result.sensors.find((s: any) => s.name === 'Tctl'));
    assert.ok(result.sensors.find((s: any) => s.name === 'Tdie'));
  });

  it('falls back to hwmon name when no temp_label file is present', () => {
    writeHwmon(tmpRoot, 0, 'coretemp', [{ tempIdx: 1, milliC: 48000 }]);

    const { collectTemperature } = loadCollector();
    const result = collectTemperature({ hostRoot: tmpRoot });
    assert.ok(result);
    assert.equal(result.sensors[0].name, 'coretemp');
  });

  it('returns null when no sensors are present', () => {
    const { collectTemperature } = loadCollector();
    assert.equal(collectTemperature({ hostRoot: tmpRoot }), null);
  });

  it('returns null when /sys paths do not exist', () => {
    const { collectTemperature } = loadCollector();
    assert.equal(collectTemperature({ hostRoot: '/nonexistent-path' }), null);
  });

  it('skips a zone with an unparseable temp file without crashing', () => {
    writeThermalZone(tmpRoot, 0, 'cpu-thermal', 45000);
    // Inject a broken zone
    const dir = path.join(tmpRoot, 'sys/class/thermal/thermal_zone1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'type'), 'broken\n');
    fs.writeFileSync(path.join(dir, 'temp'), 'not-a-number\n');

    const { collectTemperature } = loadCollector();
    const result = collectTemperature({ hostRoot: tmpRoot });
    assert.ok(result);
    // Only the first zone should make it through
    assert.equal(result.sensors.length, 1);
    assert.equal(result.sensors[0].name, 'cpu-thermal');
  });
});
