// test/graph.test.js
//
// Tests for src/graph.js: buildGraph (resolves relative import specifiers
// from indexed file records into a repo-local import graph) and neighbors
// (BFS over that graph). Exercises the real fixture repo (paths from the
// real walkRepo(fixtures/sample), imports attached per the literal source
// SPEC.md's fixture section guarantees exists on disk) plus synthetic
// file/graph shapes to pin the edge cases the SPEC clarifications call out
// explicitly: as-is-before-extension-before-index.js resolution order,
// bare-specifier dropping, self-import exclusion, dedupe, and the
// "no empty-array entries" rule for graph.out/graph.in.
//
// NOTE: fixture imports below are hard-coded from SPEC.md's fixture content
// (routes.js imports '../auth.js' and '../db.js'; migrate.py imports 'os')
// rather than obtained by calling src/imports.js's extractImports on the
// real file text. That's deliberate, not laziness: extractImports currently
// builds its per-line-anchored regexes (LANG_RULES's importPatterns all
// start with `^`) with only a "g" flag and no "m" flag, so `^` anchors to
// the start of the whole file instead of the start of each line — see
// debug output while writing this test: extractImports(routes.js text, 'js')
// returns [] because the import statements aren't on line 1 (there's a
// header comment first), and extractImports(migrate.py text, 'py') only
// happens to return ['os'] because "import os" IS line 1 there. That's a
// real bug in src/imports.js, not in graph.js, so graph.js's own tests are
// written against the imports SPEC.md guarantees rather than against
// extractImports's current (buggy) output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { walkRepo } from '../src/walk.js';
import { buildGraph, neighbors } from '../src/graph.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, '..', 'fixtures', 'sample');

// Per SPEC.md's fixture section: only these two files have any import
// statements at all; everything else has none.
const FIXTURE_IMPORTS = {
  'src/api/routes.js': ['../auth.js', '../db.js'],
  'scripts/migrate.py': ['os'],
};

// Build the minimal `files[]` shape buildGraph needs ({path, imports}) using
// the real fixture repo's real path list (via the real walkRepo, so this
// still catches e.g. a path/casing mismatch between the fixture and the
// SPEC), paired with the SPEC-guaranteed imports for each path.
async function buildFileRecords(root) {
  const walked = await walkRepo(root);
  return walked.map((entry) => ({
    path: entry.path,
    imports: FIXTURE_IMPORTS[entry.path] || [],
  }));
}

// ---------------------------------------------------------------------------
// buildGraph against fixtures/sample (per SPEC's fixture guarantees)
// ---------------------------------------------------------------------------

test('buildGraph(fixtures/sample) resolves routes.js imports to auth.js and db.js, in source order', async () => {
  const files = await buildFileRecords(FIXTURE_ROOT);
  const graph = buildGraph(files);

  assert.deepEqual(
    graph.out['src/api/routes.js'],
    ['src/auth.js', 'src/db.js'],
    'routes.js imports "../auth.js" before "../db.js" in source, so resolved edges must preserve that order'
  );
});

test('buildGraph(fixtures/sample) records the reverse edges from auth.js and db.js back to routes.js', async () => {
  const files = await buildFileRecords(FIXTURE_ROOT);
  const graph = buildGraph(files);

  assert.deepEqual(graph.in['src/auth.js'], ['src/api/routes.js']);
  assert.deepEqual(graph.in['src/db.js'], ['src/api/routes.js']);
});

test('buildGraph(fixtures/sample) drops migrate.py\'s bare "os" import (no repo file resolves)', async () => {
  const files = await buildFileRecords(FIXTURE_ROOT);
  const graph = buildGraph(files);

  assert.ok(files.some((f) => f.path === 'scripts/migrate.py'), 'sanity check: migrate.py is present in the walk');
  assert.equal(graph.out['scripts/migrate.py'], undefined, 'a bare specifier must never produce a graph edge');
});

test('buildGraph(fixtures/sample) only has keys for files with at least one resolved edge', async () => {
  const files = await buildFileRecords(FIXTURE_ROOT);
  const graph = buildGraph(files);

  // Only routes.js imports anything relative in this fixture; only auth.js
  // and db.js are imported by anything. Every other file (auth.js, db.js,
  // util.js, README.md, .gitignore, migrate.py) must be absent from both maps.
  assert.deepEqual(Object.keys(graph.out), ['src/api/routes.js']);
  assert.deepEqual(Object.keys(graph.in).sort(), ['src/auth.js', 'src/db.js']);
});

// ---------------------------------------------------------------------------
// buildGraph — synthetic edge cases pinned by the SPEC clarifications
// ---------------------------------------------------------------------------

test('buildGraph resolves an extensionless specifier by appending .js', () => {
  const files = [
    { path: 'src/a.js', imports: ['./b'] },
    { path: 'src/b.js', imports: [] },
  ];
  const graph = buildGraph(files);
  assert.deepEqual(graph.out['src/a.js'], ['src/b.js']);
});

test('buildGraph resolves an extensionless specifier by appending .ts when only a .ts file exists', () => {
  const files = [
    { path: 'src/a.js', imports: ['./c'] },
    { path: 'src/c.ts', imports: [] },
  ];
  const graph = buildGraph(files);
  assert.deepEqual(graph.out['src/a.js'], ['src/c.ts']);
});

test('buildGraph resolves a directory-style specifier to its index.js as a last resort', () => {
  const files = [
    { path: 'src/a.js', imports: ['./utils'] },
    { path: 'src/utils/index.js', imports: [] },
  ];
  const graph = buildGraph(files);
  assert.deepEqual(graph.out['src/a.js'], ['src/utils/index.js']);
});

test('buildGraph tries candidates in order: as-is, then +.js/.ts/.py, before /index.js', () => {
  // Both 'src/b.js' and 'src/b/index.js' exist; the appended-extension form
  // must win because it's tried before the /index.js fallback.
  const files = [
    { path: 'src/a.js', imports: ['./b'] },
    { path: 'src/b.js', imports: [] },
    { path: 'src/b/index.js', imports: [] },
  ];
  const graph = buildGraph(files);
  assert.deepEqual(graph.out['src/a.js'], ['src/b.js']);
});

test('buildGraph matches an already-fully-specified path as-is without appending anything', () => {
  const files = [
    { path: 'src/a.js', imports: ['./b.js'] },
    { path: 'src/b.js', imports: [] },
    // A decoy that would only match if the resolver incorrectly tried
    // /index.js before the as-is candidate.
    { path: 'src/b.js/index.js', imports: [] },
  ];
  const graph = buildGraph(files);
  assert.deepEqual(graph.out['src/a.js'], ['src/b.js']);
});

test('buildGraph drops bare (non-relative) specifiers entirely, keeping only resolvable relative ones', () => {
  const files = [
    { path: 'src/a.js', imports: ['os', 'react', './b.js'] },
    { path: 'src/b.js', imports: [] },
  ];
  const graph = buildGraph(files);
  assert.deepEqual(graph.out['src/a.js'], ['src/b.js']);
});

test('buildGraph drops an unresolvable relative specifier without throwing and without an edge', () => {
  const files = [{ path: 'src/a.js', imports: ['./nonexistent'] }];

  assert.doesNotThrow(() => buildGraph(files));
  const graph = buildGraph(files);
  assert.equal(graph.out['src/a.js'], undefined);
});

test('buildGraph excludes a self-referential import from the resolved edges', () => {
  const files = [
    { path: 'src/a.js', imports: ['./a.js', './b.js'] },
    { path: 'src/b.js', imports: [] },
  ];
  const graph = buildGraph(files);
  assert.deepEqual(graph.out['src/a.js'], ['src/b.js'], 'the self-import must be dropped, leaving only b.js');
});

test('buildGraph dedupes repeated specifiers that resolve to the same target', () => {
  const files = [
    { path: 'src/a.js', imports: ['./b.js', './b.js', './b'] }, // all three resolve to src/b.js
    { path: 'src/b.js', imports: [] },
  ];
  const graph = buildGraph(files);
  assert.deepEqual(graph.out['src/a.js'], ['src/b.js']);
});

test('buildGraph accumulates distinct importers into graph.in without duplication', () => {
  const files = [
    { path: 'src/a.js', imports: ['./target.js'] },
    { path: 'src/b.js', imports: ['./target.js'] },
    { path: 'src/target.js', imports: [] },
  ];
  const graph = buildGraph(files);
  assert.deepEqual(graph.in['src/target.js'].sort(), ['src/a.js', 'src/b.js']);
});

test('buildGraph resolves relative to the importing file\'s own directory, not the repo root', () => {
  const files = [
    { path: 'src/nested/a.js', imports: ['../shared.js'] },
    { path: 'src/shared.js', imports: [] },
  ];
  const graph = buildGraph(files);
  assert.deepEqual(graph.out['src/nested/a.js'], ['src/shared.js']);
});

test('buildGraph never emits an empty-array entry for a file with zero resolved edges', () => {
  const files = [
    { path: 'src/a.js', imports: ['os'] }, // bare only
    { path: 'src/b.js', imports: [] },
    { path: 'src/c.js' }, // imports omitted entirely
  ];
  const graph = buildGraph(files);
  assert.deepEqual(graph.out, {});
  assert.deepEqual(graph.in, {});
});

// ---------------------------------------------------------------------------
// neighbors — BFS over an already-built graph
// ---------------------------------------------------------------------------

test('neighbors defaults to depth 1', () => {
  const graph = { out: { A: ['B'], B: ['C'] }, in: { B: ['A'], C: ['B'] } };
  const result = neighbors(graph, 'A');
  assert.deepEqual(result.imports, ['B']);
  assert.deepEqual(result.importedBy, []);
});

test('neighbors BFS expands outward through depth 2', () => {
  const graph = { out: { A: ['B'], B: ['C'] }, in: { B: ['A'], C: ['B'] } };
  const result = neighbors(graph, 'A', 2);
  assert.deepEqual(result.imports, ['B', 'C']);
});

test('neighbors reports importedBy via graph.in, independent of graph.out', () => {
  const graph = { out: { A: ['B'], B: ['C'] }, in: { B: ['A'], C: ['B'] } };
  const result = neighbors(graph, 'C', 2);
  assert.deepEqual(result.importedBy, ['B', 'A']);
});

test('neighbors excludes the start node itself even when the graph has a cycle', () => {
  const graph = { out: { A: ['B'], B: ['A'] }, in: { A: ['B'], B: ['A'] } };
  const result = neighbors(graph, 'A', 5);
  assert.deepEqual(result.imports, ['B']);
  assert.ok(!result.imports.includes('A'), 'BFS must never report the start node as its own neighbor');
});

test('neighbors dedupes a diamond reached via two different paths', () => {
  const graph = { out: { A: ['B', 'C'], B: ['D'], C: ['D'] }, in: {} };
  const result = neighbors(graph, 'A', 2);
  assert.deepEqual(result.imports, ['B', 'C', 'D']);
  assert.equal(result.imports.filter((n) => n === 'D').length, 1, 'D is reachable via both B and C but must appear once');
});

test('neighbors on a file with no edges at all returns empty imports and importedBy', () => {
  const graph = { out: { A: ['B'] }, in: { B: ['A'] } };
  const result = neighbors(graph, 'Z', 2);
  assert.deepEqual(result, { imports: [], importedBy: [] });
});

test('buildGraph treats prototype-named file paths as ordinary own keys', () => {
  const special = ['constructor', 'toString', '__proto__'];
  const files = [
    { path: 'entry.js', imports: special.map((name) => `./${name}`) },
    ...special.map((name) => ({ path: name, imports: [] })),
  ];

  const graph = buildGraph(files);
  assert.deepEqual(graph.out['entry.js'], special);
  for (const name of special) {
    assert.equal(Object.hasOwn(graph.in, name), true);
    assert.deepEqual(graph.in[name], ['entry.js']);
  }

  assert.deepEqual(neighbors(graph, 'entry.js'), {
    imports: special,
    importedBy: [],
  });
});

test('neighbors ignores inherited prototype names when no matching graph key exists', () => {
  for (const name of ['constructor', 'toString', '__proto__']) {
    assert.deepEqual(neighbors({ out: {}, in: {} }, name, 2), {
      imports: [],
      importedBy: [],
    });
  }
});

test('neighbors(fixtures/sample) agrees with buildGraph output for routes.js and auth.js', async () => {
  const files = await buildFileRecords(FIXTURE_ROOT);
  const graph = buildGraph(files);

  const routes = neighbors(graph, 'src/api/routes.js', 1);
  assert.deepEqual(routes.imports.slice().sort(), ['src/auth.js', 'src/db.js']);
  assert.deepEqual(routes.importedBy, [], 'nothing in the fixture imports routes.js');

  const auth = neighbors(graph, 'src/auth.js', 1);
  assert.deepEqual(auth.imports, [], 'auth.js has no relative imports of its own');
  assert.deepEqual(auth.importedBy, ['src/api/routes.js']);
});
