// src/store.js — persist and load the on-disk index at <root>/.grasp/index.json.
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { safeResolve } from './util.js';

/**
 * Write `index` to `<root>/.grasp/index.json` atomically: the JSON is first
 * written to a uniquely-named tmp file inside `.grasp/`, then moved into
 * place with a single `rename` (atomic on the same filesystem, which `.grasp/`
 * always is since the tmp file lives alongside the destination). Creates
 * `.grasp/` if it doesn't exist yet.
 *
 * @param {string} root - absolute repo root
 * @param {object} index - the full index object (see SPEC schema)
 * @returns {Promise<void>}
 */
export async function saveIndex(root, index) {
  const indexPath = safeResolve(root, '.grasp/index.json');
  const graspDir = path.dirname(indexPath);

  await mkdir(graspDir, { recursive: true });

  const tmpName = `index.json.tmp-${randomBytes(6).toString('hex')}`;
  const tmpPath = safeResolve(root, `.grasp/${tmpName}`);

  const json = JSON.stringify(index, null, 2);

  try {
    await writeFile(tmpPath, json, 'utf8');
    await rename(tmpPath, indexPath);
  } catch (err) {
    // Best-effort cleanup: don't leave a stray tmp file behind if the write
    // or rename failed partway through.
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/**
 * Load and parse `<root>/.grasp/index.json`.
 *
 * @param {string} root - absolute repo root
 * @returns {Promise<object|null>} the parsed index, or `null` if no index
 *   file exists yet.
 */
export async function loadIndex(root) {
  const indexPath = safeResolve(root, '.grasp/index.json');

  let raw;
  try {
    raw = await readFile(indexPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid JSON in .grasp/index.json: ${err.message}`);
  }
}
