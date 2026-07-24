// test/pack.test.js
//
// Tests for src/pack.js (pack): the rank -> dedupe -> re-read-from-disk ->
// budget-fit -> render pipeline described in SPEC.md's "src/pack.js"
// per-file contract and clarifications #8 (fitToBudget prefix semantics)
// and #9 (pack budget + tokens only ever count raw code, never markdown
// scaffolding).
//
// Two fixtures are used:
//  1. fixtures/sample, indexed once via buildIndex(..., {noSave:true}) — the
//     shared deterministic repo SPEC.md pins exact assertions against (e.g.
//     "search/rank for query 'login' ranks a chunk from src/auth.js first").
//     Exact token/line numbers below were derived by running the real
//     rank()/pack() pipeline against this fixture, not guessed.
//  2. A hermetic temp repo (fs.mkdtemp) paired with a hand-built synthetic
//     index — used to exercise pack's own dedupe step (dropping a
//     ranked chunk whose range is already covered by a higher-ranked chunk
//     from the same file) in isolation. Real chunkFile() output is
//     non-overlapping by construction, so fixtures/sample can never itself
//     exercise that code path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { pack } from '../src/pack.js';
import { buildIndex } from '../src/index-build.js';
import { buildBM25 } from '../src/bm25.js';
import { estimateTokens } from '../src/tokens.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, '..', 'fixtures', 'sample');

// Build once: buildIndex(..., {noSave:true}) never writes .grasp/index.json,
// and rank() (which pack calls internally) only ever reads index.bm25 and
// index.graph — it never mutates the index object — so this is safe to
// share, read-only, across every fixture-grounded test below.
const index = await buildIndex(FIXTURE_ROOT, { noSave: true });

function makeSyntheticIndex(root, chunks) {
  const bm25 = buildBM25(chunks.map((c) => ({ id: c.id, tokens: c.tokens })));
  const chunkMeta = Object.fromEntries(
    chunks.map((c) => [c.id, {
      file: c.file,
      startLine: c.startLine,
      endLine: c.endLine,
      symbol: null,
    }])
  );
  const grouped = new Map();
  for (const c of chunks) {
    if (!grouped.has(c.file)) grouped.set(c.file, []);
    grouped.get(c.file).push({
      id: c.id,
      startLine: c.startLine,
      endLine: c.endLine,
      symbol: null,
    });
  }
  const files = [...grouped].map(([file, fileChunks]) => ({
    path: file,
    lang: 'js',
    size: 0,
    lines: Math.max(...fileChunks.map((c) => c.endLine)),
    hash: 'x',
    symbols: [],
    imports: [],
    chunks: fileChunks,
  }));
  return {
    version: 1,
    root,
    createdAt: 0,
    fileCount: files.length,
    chunkCount: chunks.length,
    files,
    bm25: { ...bm25, chunkMeta },
    graph: { out: {}, in: {} },
  };
}

// ---------------------------------------------------------------------------
// fixtures/sample, generous budget — SPEC.md fixture guarantee: "search/rank
// for query 'login' ranks a chunk from src/auth.js first" (line 100).
// ---------------------------------------------------------------------------

test('pack("login") with a generous budget includes every ranked chunk, src/auth.js first', async () => {
  const result = await pack(index, FIXTURE_ROOT, 'login', { budget: 8000 });

  assert.equal(result.tokens, 222);
  assert.equal(result.included.length, 6);
  assert.deepEqual(result.trimmed, []);

  // Top-ranked chunk must be login() itself, from src/auth.js.
  assert.deepEqual(result.included[0], { file: 'src/auth.js', startLine: 3, endLine: 9, tokens: 39 });

  // tokens is exactly the sum of included chunk tokens (clarification #9);
  // budget bounds only that sum, never the markdown scaffolding.
  const sum = result.included.reduce((acc, c) => acc + c.tokens, 0);
  assert.equal(result.tokens, sum);
  assert.ok(result.tokens <= 8000);

  // Markdown scaffolding.
  assert.ok(result.text.startsWith('# grasp pack: login\n'));
  assert.ok(result.text.includes('## src/auth.js'));
  assert.ok(result.text.includes('// src/auth.js:3-9'));
  assert.ok(result.text.includes('// src/auth.js:1-2'));
  assert.ok(result.text.includes('## src/api/routes.js'));
  assert.ok(result.text.includes('## README.md'));
  assert.ok(result.text.includes('```js'));
  assert.ok(result.text.includes('```text')); // README.md's detected lang

  // Every ranked chunk fit, so no "Trimmed" section and no per-file drop notes.
  assert.ok(!result.text.includes('Trimmed (not included)'));
  assert.ok(!result.text.includes('omitted — budget exceeded'));

  // Sections must appear in ranked-file order (src/auth.js highest score,
  // then src/api/routes.js, then README.md — SPEC.md "Ranking algorithm"
  // step 5: sort desc by score).
  const iAuth = result.text.indexOf('## src/auth.js');
  const iRoutes = result.text.indexOf('## src/api/routes.js');
  const iReadme = result.text.indexOf('## README.md');
  assert.ok(iAuth < iRoutes && iRoutes < iReadme, 'sections must appear in ranked-file order');
});

test('pack("login") honors opts.top: rank is capped before budgeting ever runs', async () => {
  const result = await pack(index, FIXTURE_ROOT, 'login', { top: 1 });

  assert.equal(result.included.length, 1);
  assert.deepEqual(result.included[0], { file: 'src/auth.js', startLine: 3, endLine: 9, tokens: 39 });
  assert.equal(result.tokens, 39);
  assert.deepEqual(result.trimmed, []);
});

// ---------------------------------------------------------------------------
// fixtures/sample, tight budgets — exercises clarification #8's prefix
// semantics (stop at the first chunk that would overflow; that chunk and
// everything after it is dropped) and pack's file-level "partially dropped"
// vs "fully dropped" rendering (SPEC.md "src/pack.js" step 5).
// ---------------------------------------------------------------------------

test('pack("login", budget:150) fully drops the lowest-ranked file (README.md) but keeps the rest whole', async () => {
  const result = await pack(index, FIXTURE_ROOT, 'login', { budget: 150 });

  assert.equal(result.tokens, 138);
  assert.equal(result.included.length, 5);
  assert.ok(result.tokens <= 150);

  const files = new Set(result.included.map((c) => c.file));
  assert.deepEqual(files, new Set(['src/auth.js', 'src/api/routes.js']));

  // `trimmed` lists every file that lost >=1 chunk, partially or fully —
  // here only README.md lost chunks (all of them).
  assert.deepEqual(result.trimmed, ['README.md']);

  assert.ok(result.text.includes('## Trimmed (not included)'));
  assert.ok(result.text.includes('- README.md — see `grasp outline README.md`'));

  // Neither surviving file lost any of ITS OWN chunks at this budget, so
  // neither gets an inline "omitted" note, and README.md's section is gone.
  assert.ok(!result.text.includes('omitted — budget exceeded'));
  assert.ok(!result.text.includes('## README.md'));
});

test('pack("login", budget:100) partially drops two files and fully drops README.md', async () => {
  const result = await pack(index, FIXTURE_ROOT, 'login', { budget: 100 });

  assert.equal(result.tokens, 82);
  assert.equal(result.included.length, 3);
  assert.ok(result.tokens <= 100);
  assert.deepEqual(
    result.included.map((c) => `${c.file}:${c.startLine}-${c.endLine}`),
    ['src/auth.js:3-9', 'src/api/routes.js:7-10', 'src/api/routes.js:11-17']
  );

  // Every file that had ANY chunk fail to make the cut is in `trimmed`,
  // including files that are still partially represented in `included`.
  assert.deepEqual(result.trimmed, ['src/auth.js', 'src/api/routes.js', 'README.md']);

  assert.ok(
    result.text.includes('_(more of src/auth.js omitted — budget exceeded; see `grasp outline src/auth.js`)_')
  );
  assert.ok(
    result.text.includes(
      '_(more of src/api/routes.js omitted — budget exceeded; see `grasp outline src/api/routes.js`)_'
    )
  );

  // The "Trimmed (not included)" *section*, unlike the returned `trimmed`
  // array, is reserved for files with ZERO surviving chunks — so it must
  // name README.md only, not the two partially-dropped files.
  const trimmedSection = result.text.slice(result.text.indexOf('## Trimmed (not included)'));
  assert.ok(trimmedSection.includes('- README.md'));
  assert.ok(!trimmedSection.includes('src/auth.js'));
  assert.ok(!trimmedSection.includes('src/api/routes.js'));
});

test('pack("login", budget:20) — nothing fits, every ranked file is reported as trimmed', async () => {
  const result = await pack(index, FIXTURE_ROOT, 'login', { budget: 20 });

  assert.equal(result.tokens, 0);
  assert.deepEqual(result.included, []);
  assert.deepEqual(result.trimmed, ['src/auth.js', 'src/api/routes.js', 'README.md']);

  assert.ok(result.text.includes('_no chunks fit within budget 20_'));
  assert.ok(result.text.includes('## Trimmed (not included)'));
  for (const f of ['src/auth.js', 'src/api/routes.js', 'README.md']) {
    assert.ok(result.text.includes(`- ${f} — see \`grasp outline ${f}\``));
  }
});

test('pack() with a query matching no corpus term returns an empty, un-trimmed pack', async () => {
  // No chunk in fixtures/sample contains this term, so scoreBM25 returns an
  // empty Map, rank() returns [], and pack never reaches fitToBudget with any
  // candidates at all — `trimmed` must stay empty (nothing was dropped;
  // nothing was ever ranked in the first place).
  const result = await pack(index, FIXTURE_ROOT, 'xyzzyquuxnonexistentterm', {});

  assert.equal(result.tokens, 0);
  assert.deepEqual(result.included, []);
  assert.deepEqual(result.trimmed, []);
  assert.ok(!result.text.includes('Trimmed (not included)'));
  assert.ok(result.text.includes('_no chunks fit within budget'));
});

// ---------------------------------------------------------------------------
// Synthetic index + hermetic temp repo — isolates pack's own dedupe step
// (SPEC.md "src/pack.js": "drop any ranked chunk whose line range is already
// fully covered by a higher-ranked chunk from the same file"). Real
// chunkFile() output is non-overlapping by construction, so this behavior is
// otherwise untestable against fixtures/sample; a hand-built bm25 structure
// lets us force two overlapping "chunks" over one real on-disk file so the
// dedupe outcome is fully deterministic and does not depend on rank.js's
// internals beyond the documented BM25 formula.
// ---------------------------------------------------------------------------

test('pack() dedupes a lower-ranked chunk whose range is fully covered by a higher-ranked chunk', async () => {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'grasp-pack-dedupe-'));
  try {
    const fileLines = Array.from({ length: 20 }, (_, i) => `line${i + 1} foo bar`);
    await fsp.writeFile(path.join(tmpRoot, 'big.js'), fileLines.join('\n') + '\n');
    const wholeFileCode = fileLines.join('\n');

    // Two synthetic chunks over the SAME file: "0:0" spans the whole file,
    // "0:1" is a narrower range fully contained within it. Postings give
    // "0:0" a much higher term frequency for "foo", so classic BM25
    // guarantees it scores (and therefore ranks) higher than "0:1" —
    // deterministically, without depending on any tie-break — which is what
    // makes the dedupe outcome below unambiguous.
    const syntheticIndex = {
      version: 1,
      root: tmpRoot,
      createdAt: Date.now(),
      fileCount: 1,
      chunkCount: 2,
      files: [
        {
          path: 'big.js',
          lang: 'js',
          size: 100,
          lines: 20,
          hash: 'x',
          symbols: [],
          imports: [],
          chunks: [
            { id: '0:0', startLine: 1, endLine: 20, symbol: null },
            { id: '0:1', startLine: 5, endLine: 10, symbol: null },
          ],
        },
      ],
      bm25: {
        N: 2,
        avgdl: 12.5,
        df: { foo: 2 },
        postings: { foo: [['0:0', 5], ['0:1', 1]] },
        docLen: { '0:0': 20, '0:1': 5 },
        chunkMeta: {
          '0:0': { file: 'big.js', startLine: 1, endLine: 20, symbol: null },
          '0:1': { file: 'big.js', startLine: 5, endLine: 10, symbol: null },
        },
      },
      graph: { out: {}, in: {} },
    };

    const result = await pack(syntheticIndex, tmpRoot, 'foo', { budget: 8000 });

    // Only the covering chunk survives; the fully-covered "0:1" (lines 5-10)
    // must never reach `included`, and its range must not appear anywhere in
    // the rendered text either (a failed dedupe would show up as a second,
    // overlapping fenced block/title for the same file).
    assert.equal(result.included.length, 1);
    assert.deepEqual(result.included[0], {
      file: 'big.js',
      startLine: 1,
      endLine: 20,
      tokens: estimateTokens(wholeFileCode),
    });
    assert.equal(result.tokens, estimateTokens(wholeFileCode));
    assert.deepEqual(result.trimmed, []);

    assert.ok(result.text.includes('// big.js:1-20'));
    assert.ok(!result.text.includes('big.js:5-10'));
    const codeBlockCount = (result.text.match(/```js/g) || []).length;
    assert.equal(codeBlockCount, 1, 'exactly one fenced code block, not two overlapping ones');
  } finally {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('pack() trims a partial overlap while preserving the later unique lines', async () => {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'grasp-pack-overlap-'));
  try {
    const lines = Array.from({ length: 15 }, (_, i) => `line${i + 1} foo`);
    await fsp.writeFile(path.join(tmpRoot, 'big.js'), lines.join('\n'));
    const syntheticIndex = makeSyntheticIndex(tmpRoot, [
      { id: '0:0', file: 'big.js', startLine: 1, endLine: 10, tokens: ['foo'] },
      { id: '0:1', file: 'big.js', startLine: 8, endLine: 15, tokens: ['foo'] },
    ]);

    const result = await pack(syntheticIndex, tmpRoot, 'foo', { budget: 8000 });
    assert.deepEqual(
      result.included.map((c) => [c.startLine, c.endLine]),
      [[1, 10], [11, 15]]
    );
    assert.ok(!result.text.includes('// big.js:8-15'));
    assert.ok(result.text.includes('// big.js:11-15'));
  } finally {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('pack() does not read lower-ranked files after the prefix budget overflows', async () => {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'grasp-pack-prefix-'));
  try {
    await fsp.writeFile(path.join(tmpRoot, 'a.js'), 'foo\n');
    const syntheticIndex = makeSyntheticIndex(tmpRoot, [
      { id: '0:0', file: 'a.js', startLine: 1, endLine: 1, tokens: ['foo'] },
      { id: '1:0', file: 'missing.js', startLine: 1, endLine: 1, tokens: ['foo'] },
    ]);

    const result = await pack(syntheticIndex, tmpRoot, 'foo', { budget: 0 });
    assert.deepEqual(result.included, []);
    assert.deepEqual(result.trimmed, ['a.js', 'missing.js']);
  } finally {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('pack() rejects budgets that cannot satisfy the tokens <= budget invariant', async () => {
  for (const budget of [-1, NaN, Infinity]) {
    await assert.rejects(
      () => pack(index, FIXTURE_ROOT, 'login', { budget }),
      /budget must be a non-negative finite number/
    );
  }
});
