// test/demotion.test.js
//
// Covers the source-priority demotion added to rank.js: test/fixture/generated
// files are pushed below real source by default, and the opt-out (includeTests)
// restores full-weight ranking. Uses a hermetic temp repo so it never depends
// on git tracking or the shared fixture.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { rank, sourcePriority } from '../src/rank.js';
import { buildIndex } from '../src/index-build.js';

test('sourcePriority(): real source is 1, non-source is demoted', () => {
  // Real source — full weight.
  assert.equal(sourcePriority('src/auth.js'), 1);
  assert.equal(sourcePriority('packages/react-reconciler/src/ReactFiberHooks.js'), 1);
  // Word-boundary safety: these merely CONTAIN "test"/"spec" and must NOT demote.
  assert.equal(sourcePriority('src/attestation.js'), 1);
  assert.equal(sourcePriority('src/constitution.ts'), 1);
  assert.equal(sourcePriority('lib/inspector.js'), 1);

  // Demoted by directory segment.
  assert.ok(sourcePriority('src/__tests__/auth.js') < 1);
  assert.ok(sourcePriority('packages/x/fixtures/data.js') < 1);
  assert.ok(sourcePriority('docs/guide.js') < 1);
  assert.ok(sourcePriority('examples/demo.js') < 1);
  // Demoted by filename suffix.
  assert.ok(sourcePriority('a/b/widget.test.js') < 1);
  assert.ok(sourcePriority('a/b/widget.spec.tsx') < 1);
  assert.ok(sourcePriority('a/b/thing.snap') < 1);
  // Demoted by whole-word basename marker (the react case: -test-cases.js).
  assert.ok(sourcePriority('scripts/eslint-plugin-react-hooks-test-cases.js') < 1);
});

test('rank(): a noisy test file is demoted below real source by default, restored with includeTests', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'grasp-demote-'));
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await mkdir(path.join(dir, 'src', '__tests__'), { recursive: true });

  // Real source: a few occurrences of the query term "alpha". The symbol name
  // ("draw") deliberately does NOT contain the term, so the demotion effect is
  // isolated from the symbol boost.
  await writeFile(
    path.join(dir, 'src', 'panel.js'),
    'export function draw() {\n  // alpha alpha alpha\n  return alpha;\n}\n'
  );
  // Test file: MORE occurrences of the term, so it wins on raw BM25 term frequency.
  await writeFile(
    path.join(dir, 'src', '__tests__', 'panel.test.js'),
    'alpha alpha alpha alpha alpha alpha alpha alpha\n'
  );

  const index = await buildIndex(dir, { noSave: true });

  const def = rank(index, 'alpha', {});
  assert.ok(def.length >= 1, 'expected at least one ranked chunk');
  assert.ok(
    def[0].file.endsWith('src/panel.js'),
    `default ranking must put real source first, got ${def[0].file}`
  );

  const withTests = rank(index, 'alpha', { includeTests: true });
  assert.ok(
    withTests[0].file.includes('__tests__'),
    `with includeTests the higher-tf test file should win, got ${withTests[0].file}`
  );
});
