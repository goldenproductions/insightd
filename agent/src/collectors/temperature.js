const fs = require('fs');
const path = require('path');
const logger = require('../../../shared/utils/logger');

/**
 * Collect temperature readings from sysfs thermal zones and hwmon.
 * Returns null if no sensors available.
 */
function collectTemperature(config) {
  const hostRoot = config?.hostRoot || '/host';
  const sensors = [];

  // Read thermal zones
  try {
    const thermalBase = path.join(hostRoot, 'sys/class/thermal');
    const zones = fs.readdirSync(thermalBase).filter(d => d.startsWith('thermal_zone'));
    for (const zone of zones) {
      try {
        const type = fs.readFileSync(path.join(thermalBase, zone, 'type'), 'utf8').trim();
        const temp = parseInt(fs.readFileSync(path.join(thermalBase, zone, 'temp'), 'utf8').trim(), 10);
        if (!isNaN(temp)) {
          sensors.push({ name: type || zone, temperatureCelsius: Math.round(temp / 100) / 10 });
        }
      } catch { /* zone unreadable */ }
    }
  } catch { /* /sys/class/thermal not available */ }

  // Read hwmon sensors for more detail
  try {
    const hwmonBase = path.join(hostRoot, 'sys/class/hwmon');
    const hwmons = fs.readdirSync(hwmonBase);
    for (const hwmon of hwmons) {
      try {
        const hwmonPath = path.join(hwmonBase, hwmon);
        const name = fs.readFileSync(path.join(hwmonPath, 'name'), 'utf8').trim();
        const files = fs.readdirSync(hwmonPath).filter(f => f.match(/^temp\d+_input$/));
        for (const f of files) {
          try {
            const temp = parseInt(fs.readFileSync(path.join(hwmonPath, f), 'utf8').trim(), 10);
            const labelFile = f.replace('_input', '_label');
            let label = name;
            try { label = fs.readFileSync(path.join(hwmonPath, labelFile), 'utf8').trim(); } catch { /* no label */ }
            if (!isNaN(temp)) {
              // Only add if not already covered by thermal zones (avoid duplicates)
              const tempC = Math.round(temp / 100) / 10;
              const exists = sensors.some(s => Math.abs(s.temperatureCelsius - tempC) < 0.5 && s.name.toLowerCase().includes(name.toLowerCase()));
              if (!exists) {
                sensors.push({ name: label, temperatureCelsius: tempC });
              }
            }
          } catch { /* temp file unreadable */ }
        }
      } catch { /* hwmon unreadable */ }
    }
  } catch { /* /sys/class/hwmon not available */ }

  if (sensors.length === 0) return null;

  logger.info('temperature', `Read ${sensors.length} temperature sensors`);
  return { sensors };
}

module.exports = { collectTemperature };
