const { execSync } = require('child_process');
const logger = require('../../../shared/utils/logger');

/**
 * Collect GPU metrics via nvidia-smi.
 * Returns null if no Nvidia GPU or nvidia-smi not available.
 */
function collectGpu() {
  try {
    const output = execSync(
      'nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits',
      { timeout: 5000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    if (!output) return null;

    const gpus = output.split('\n').map(line => {
      const [name, util, memUsed, memTotal, temp] = line.split(', ').map(s => s.trim());
      return {
        name: name || 'Unknown',
        utilizationPercent: parseFloat(util) || 0,
        memoryUsedMb: parseFloat(memUsed) || 0,
        memoryTotalMb: parseFloat(memTotal) || 0,
        temperatureCelsius: parseFloat(temp) || null,
      };
    });

    return { gpus };
  } catch {
    // nvidia-smi not available or no GPU
    return null;
  }
}

module.exports = { collectGpu };
