import type { Registry } from './types';
const { loadRegistry } = require('./loader');

let cached: Registry | null = null;

function getRegistry(rootDir: string): Registry {
  if (cached) return cached;
  const loaded = loadRegistry(rootDir) as Registry;
  cached = loaded;
  return loaded;
}

function resetRegistryForTest(): void {
  cached = null;
}

module.exports = { getRegistry, resetRegistryForTest };
