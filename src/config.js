// src/config.js — default configuration and per-repo config loading.
import { readFile } from 'node:fs/promises';
import { safeResolve } from './util.js';

export const DEFAULTS = {
  maxFileSize: 1_000_000,
  chunkMaxLines: 60,
  top: 20,
  budget: 8000,
  k1: 1.5,
  b: 0.75,
};

// loadConfig(root) → DEFAULTS merged with <root>/.grasp/config.json if present.
export async function loadConfig(root) {
  const configPath = safeResolve(root, '.grasp/config.json');

  let raw;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { ...DEFAULTS };
    }
    throw err;
  }

  let overrides;
  try {
    overrides = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid JSON in .grasp/config.json: ${err.message}`);
  }

  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('.grasp/config.json must contain a JSON object');
  }

  return { ...DEFAULTS, ...overrides };
}
