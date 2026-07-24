// test/store.test.js
//
// Tests for src/store.js (saveIndex/loadIndex): atomic persistence of the
// index JSON at <root>/.grasp/index.json. Exercises a real, schema-conformant
// index built from fixtures/sample (via index-build.buildIndex, noSave:true)
// for the end-to-end round-trip, and hermetic temp repos (fs.mkdtemp) for the
// filesystem-shape assertions (missing file, overwrite, leftover tmp files,
// invalid JSON) so none of them depend on or mutate the shared fixture.
//
// NOT asserted here: SPEC.md's guarantee that graph.out['src/api/routes.js']
// resolves to src/auth.js and src/db.js. That guarantee currently fails
// (independently reproduced by test/imports.test.js) because
// src/lang.js's js/py/generic importPatterns anchor with `^` but are never
// given the `m` flag, and src/imports.js matches them against the whole file
// text rather than line-by-line — so `^` only matches position 0 of the
// entire file, not the start of each line. Any import statement that isn't
// literally the file's first line (e.g. routes.js, which has a header
// comment above its imports) is silently dropped from extractImports, and
// therefore from buildGraph's edges. This is a bug in lang.js/imports.js, not
// in store.js, so store.test.js instead asserts that store.js round-trips
// whatever `graph` shape it is given byte-for-byte, which is the whole of
// store.js's actual contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { promises as fsp } from 'node:fs';

import { saveIndex, loadIndex } from '../src/store.js';
import { buildIndex } from '../src/index-build.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, '..', 'fixtures', 'sample');

async function makeTempRoot(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

// A small but schema-shaped index object (see SPEC.md "Index JSON schema"),
// used for tests that only care about store.js's filesystem behavior, not
// about realistic content. `marker` is an extra field to distinguish
// instances in the overwrite test; store.js persists whatever object it is
// given, it does not validate the schema.
function makeMinimalIndex(root, overrides = {}) {
  return {
    version: 1,
    root,
    createdAt: 1,
    fileCount: 0,
    chunkCount: 0,
    files: [],
    bm25: { N: 0, avgdl: 0, df: {}, postings: {}, docLen: {}, chunkMeta: {} },
    graph: { out: {}, in: {} },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// loadIndex on an absent index
// ---------------------------------------------------------------------------

test('loadIndex returns null when the .grasp directory does not exist at all', async () => {
  const root = await makeTempRoot('grasp-store-missing-dir-');
  try {
    assert.equal(await loadIndex(root), null);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('loadIndex returns null when .grasp exists but index.json is missing', async () => {
  const root = await makeTempRoot('grasp-store-missing-file-');
  try {
    await fsp.mkdir(path.join(root, '.grasp'), { recursive: true });
    assert.equal(await loadIndex(root), null);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// saveIndex + loadIndex round-trip a real fixture-built index
// ---------------------------------------------------------------------------

test('saveIndex creates .grasp/index.json (dir did not exist) with valid JSON matching the input, and loadIndex round-trips it exactly', async () => {
  const built = await buildIndex(FIXTURE_ROOT, { noSave: true });
  const root = await makeTempRoot('grasp-store-roundtrip-');
  try {
    // Precondition: no .grasp/ yet in the fresh temp root.
    await assert.rejects(() => fsp.stat(path.join(root, '.grasp')), /ENOENT/);

    await saveIndex(root, built);

    const indexPath = path.join(root, '.grasp', 'index.json');
    const stat = await fsp.stat(indexPath);
    assert.ok(stat.isFile(), '.grasp/index.json must exist as a regular file after saveIndex');

    // Read the raw bytes directly (bypassing loadIndex) to confirm saveIndex
    // itself persisted valid, faithful JSON on disk.
    const raw = await fsp.readFile(indexPath, 'utf8');
    const parsedRaw = JSON.parse(raw);
    assert.deepEqual(parsedRaw, built, 'raw on-disk JSON must deep-equal the object passed to saveIndex');

    // Now go through the public loadIndex API.
    const loaded = await loadIndex(root);
    assert.deepEqual(loaded, built, 'loadIndex must return an object deep-equal to what was saved');

    // Grounded assertions from SPEC's fixture guarantees, checked on the
    // round-tripped object (proves store.js didn't drop/reshape anything
    // load-bearing along the way).
    assert.equal(loaded.fileCount, 7, 'fixture has exactly 7 eligible files per SPEC (ignored/binary excluded)');

    const authFile = loaded.files.find((f) => f.path === 'src/auth.js');
    assert.ok(authFile, 'src/auth.js must be present in the round-tripped index');
    const authSymbolNames = authFile.symbols.map((s) => s.name);
    assert.ok(authSymbolNames.includes('login'), 'auth.js symbols must include login');
    assert.ok(authSymbolNames.includes('logout'), 'auth.js symbols must include logout');
    assert.ok(authSymbolNames.includes('TOKEN_TTL'), 'auth.js symbols must include TOKEN_TTL');

    // NOTE: SPEC.md also guarantees graph.out['src/api/routes.js'] resolves to
    // both src/auth.js and src/db.js. That is deliberately NOT asserted here:
    // it currently fails due to a pre-existing bug in src/lang.js, not in
    // store.js (see this file's header comment / test notes). The overall
    // `assert.deepEqual(loaded, built, ...)` above already proves store.js
    // faithfully round-trips whatever `graph` shape buildIndex produced,
    // bug-for-bug, which is all store.js is responsible for.
    assert.deepEqual(loaded.graph, built.graph, 'graph must round-trip byte-for-byte regardless of its content');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Atomicity: no leftover tmp files, and repeated saves overwrite cleanly
// ---------------------------------------------------------------------------

test('saveIndex leaves no leftover tmp-* files behind after a successful write', async () => {
  const root = await makeTempRoot('grasp-store-atomic-');
  try {
    await saveIndex(root, makeMinimalIndex(root, { marker: 'only-save' }));

    const entries = await fsp.readdir(path.join(root, '.grasp'));
    assert.deepEqual(entries, ['index.json'], '.grasp/ must contain exactly index.json, no stray tmp files');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('saveIndex on repeated calls overwrites previous content (last write wins, not merged)', async () => {
  const root = await makeTempRoot('grasp-store-overwrite-');
  try {
    await saveIndex(root, makeMinimalIndex(root, { marker: 'v1', fileCount: 1 }));
    await saveIndex(root, makeMinimalIndex(root, { marker: 'v2', fileCount: 2 }));

    const loaded = await loadIndex(root);
    assert.equal(loaded.marker, 'v2', 'second save must fully replace the first, not merge fields');
    assert.equal(loaded.fileCount, 2);

    // No trace of the first save's distinguishing fields should linger, and
    // no stray tmp file should remain either.
    const entries = await fsp.readdir(path.join(root, '.grasp'));
    assert.deepEqual(entries, ['index.json']);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Error path: corrupt on-disk JSON
// ---------------------------------------------------------------------------

test('loadIndex throws a descriptive error when index.json contains invalid JSON', async () => {
  const root = await makeTempRoot('grasp-store-corrupt-');
  try {
    await fsp.mkdir(path.join(root, '.grasp'), { recursive: true });
    await fsp.writeFile(path.join(root, '.grasp', 'index.json'), '{ this is not valid JSON', 'utf8');

    await assert.rejects(
      () => loadIndex(root),
      (err) => err instanceof Error && /invalid JSON/i.test(err.message)
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
