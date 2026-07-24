import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

import * as api from '../src/index.js';
import { DEFAULTS, loadConfig } from '../src/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(HERE, '..', 'fixtures', 'sample');

test('public API barrel exports exactly the contracted eight functions', () => {
  assert.deepEqual(Object.keys(api).sort(), [
    'buildIndex',
    'loadIndex',
    'outlineFile',
    'outlineRepo',
    'pack',
    'query',
    'rank',
    'saveIndex',
  ]);
  for (const value of Object.values(api)) assert.equal(typeof value, 'function');
});

test('loadConfig returns independent defaults when config.json is absent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grasp-config-default-'));
  try {
    const first = await loadConfig(root);
    assert.deepEqual(first, DEFAULTS);
    first.top = 1;
    assert.deepEqual(await loadConfig(root), DEFAULTS);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loadConfig merges repo overrides over DEFAULTS', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grasp-config-merge-'));
  try {
    await mkdir(path.join(root, '.grasp'));
    await writeFile(
      path.join(root, '.grasp', 'config.json'),
      JSON.stringify({ top: 7, budget: 1234 })
    );
    assert.deepEqual(await loadConfig(root), { ...DEFAULTS, top: 7, budget: 1234 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loadConfig reports malformed and non-object config clearly', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grasp-config-invalid-'));
  try {
    await mkdir(path.join(root, '.grasp'));
    const configPath = path.join(root, '.grasp', 'config.json');
    await writeFile(configPath, '{ nope');
    await assert.rejects(loadConfig(root), /invalid JSON in \.grasp\/config\.json/);

    await writeFile(configPath, '[]');
    await assert.rejects(loadConfig(root), /must contain a JSON object/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('public buildIndex/query/pack API works against a persisted index', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grasp-api-'));
  try {
    await cp(FIXTURE_ROOT, root, { recursive: true });
    const built = await api.buildIndex(root);
    const { results, index } = await api.query(root, 'login', { top: 3 });
    assert.equal(index.chunkCount, built.chunkCount);
    assert.equal(results[0].file, 'src/auth.js');

    const bundle = await api.pack(index, root, 'login', { budget: 300 });
    assert.ok(bundle.tokens <= 300);
    assert.equal(bundle.included[0].file, 'src/auth.js');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
