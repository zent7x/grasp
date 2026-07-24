// test/rank.test.js
//
// Tests for src/rank.js — the core ranking pipeline: BM25 scoring, symbol
// boost, graph-proximity boost, final sort/tie-break, and top-N slicing
// (SPEC.md "Ranking algorithm" + clarifications #1, #4-#11).
//
// Two kinds of fixtures are used:
//   - The REAL fixtures/sample repo, indexed once via the real buildIndex()
//     pipeline, to ground rank() against SPEC's guaranteed assertion
//     ("search/rank for query 'login' ranks a chunk from src/auth.js first")
//     and to exercise the real graph built from routes.js's actual imports.
//   - Small, hand-built synthetic index objects (built from the REAL
//     buildBM25/scoreBM25 so BM25 arithmetic is never reimplemented/guessed
//     here) that isolate one behavior at a time: the symbol-boost formula and
//     its cap, the graph-boost's "top 10 seeds only" cutoff, the "applied
//     once per chunk" dedup, the "boosts never introduce new chunks" rule,
//     and the deterministic (score desc, file asc, startLine asc) tie-break.
// rank.js is pure (no disk access), so the synthetic indices need no temp
// repo on disk — they are plain objects matching the SPEC.md index schema.

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { rank } from '../src/rank.js';
import { buildBM25, scoreBM25 } from '../src/bm25.js';
import { tokenize } from '../src/tokenize.js';
import { buildIndex } from '../src/index-build.js';

const FIXTURE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'sample'
);

function assertClose(actual, expected, msg) {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${msg}: expected ${actual} to be close to ${expected}`
  );
}

/**
 * Build a minimal, schema-shaped index object directly from a list of
 * `{ id, tokens, file, startLine, endLine, symbol }` chunk entries, using the
 * REAL buildBM25 to derive N/avgdl/df/postings/docLen (never hand-computed),
 * plus a caller-supplied graph (defaults to no edges).
 */
function buildSyntheticIndex(entries, graph = { out: {}, in: {} }) {
  const docs = entries.map((e) => ({ id: e.id, tokens: e.tokens }));
  const bm25 = buildBM25(docs);
  const chunkMeta = {};
  for (const e of entries) {
    chunkMeta[e.id] = {
      file: e.file,
      startLine: e.startLine,
      endLine: e.endLine,
      symbol: e.symbol ?? null,
    };
  }
  return { bm25: { ...bm25, chunkMeta }, graph };
}

// ---------------------------------------------------------------------------
// Real fixture: fixtures/sample, indexed once via the real pipeline.
// ---------------------------------------------------------------------------

const fixtureIndex = await buildIndex(FIXTURE_ROOT, { noSave: true });

test('rank() on the real fixture: query "login" ranks a chunk from src/auth.js first (SPEC fixture guarantee)', () => {
  const results = rank(fixtureIndex, 'login');
  assert.ok(results.length > 0, 'expected at least one ranked result');
  assert.equal(results[0].file, 'src/auth.js');
  assert.ok(results[0].reasons[0].startsWith('bm25:'), 'first reason must be the bm25 tag');
});

test('rank() on the real fixture: the login() chunk gets a symbol-boost reason for query "login"', () => {
  const results = rank(fixtureIndex, 'login', { top: 50 });
  const loginChunk = results.find((r) => r.symbol === 'login');
  assert.ok(loginChunk, 'expected a result whose symbol is exactly "login"');
  assert.ok(
    loginChunk.reasons.includes('symbol:login'),
    `expected a "symbol:login" reason, got ${JSON.stringify(loginChunk.reasons)}`
  );
});

test('rank() on the real fixture: graph proximity boosts routes.js via its real import edges to auth.js/db.js', () => {
  // Ground the boost in the actual graph the real pipeline built, so this
  // test fails loudly (not silently) if fixture/graph-building behavior ever
  // changes underneath it.
  assert.ok(
    new Set(fixtureIndex.graph.out['src/api/routes.js']).has('src/auth.js'),
    'precondition: routes.js must import auth.js in the real built graph'
  );
  assert.ok(
    new Set(fixtureIndex.graph.out['src/api/routes.js']).has('src/db.js'),
    'precondition: routes.js must import db.js in the real built graph'
  );

  const results = rank(fixtureIndex, 'login', { top: 50 });

  // auth.js is a graph neighbor of routes.js (routes.js imports it), and
  // routes.js itself contains the term "login" (it calls login(...)), so
  // both ends of that edge should be present with a graph: reason.
  const authChunk = results.find((r) => r.file === 'src/auth.js' && r.symbol === 'login');
  assert.ok(authChunk, 'expected the auth.js login() chunk in results');
  assert.ok(
    authChunk.reasons.some((r) => r.startsWith('graph:')),
    `expected a graph: reason on the auth.js login chunk, got ${JSON.stringify(authChunk.reasons)}`
  );

  // db.js never mentions "login" anywhere in its source, so it must have no
  // positive BM25 score for this query — and per SPEC clarification #5,
  // being a graph neighbor of a scored chunk (routes.js) must NOT be enough
  // to conjure it into the results on its own.
  assert.ok(
    !results.some((r) => r.file === 'src/db.js'),
    'src/db.js has no "login" term match and must never appear in results, even though it is a graph neighbor of routes.js'
  );
});

test('rank() on the real fixture is deterministic across repeated calls on the same index', () => {
  const a = rank(fixtureIndex, 'login', { top: 10 });
  const b = rank(fixtureIndex, 'login', { top: 10 });
  assert.deepEqual(a, b);
});

// ---------------------------------------------------------------------------
// Synthetic: symbol boost changes the winner vs. raw BM25 ordering.
// ---------------------------------------------------------------------------

test('rank(): symbol boost (+1.5 per matched subtoken) can outrank a chunk with a higher raw BM25 score', () => {
  const entries = [
    { id: '0:0', tokens: ['login'], file: 'src/auth.js', startLine: 3, endLine: 8, symbol: 'login' },
    { id: '0:1', tokens: ['logout'], file: 'src/auth.js', startLine: 10, endLine: 12, symbol: 'logout' },
    // Higher tf/dl than 0:0, so its raw BM25 score for "login" is higher...
    { id: '1:0', tokens: ['login', 'login'], file: 'src/db.js', startLine: 1, endLine: 8, symbol: 'connect' },
    // ...and this one too, but neither symbol ("connect"/"registerRoutes")
    // matches the query term "login" the way 0:0's own symbol does.
    { id: '2:0', tokens: ['login', 'routes', 'register'], file: 'src/api/routes.js', startLine: 6, endLine: 13, symbol: 'registerRoutes' },
    // No "login" term at all: must never be scored or appear in results.
    { id: '3:0', tokens: ['widget', 'gadget'], file: 'src/other.js', startLine: 1, endLine: 4, symbol: null },
  ];

  const graph = {
    out: { 'src/api/routes.js': ['src/auth.js', 'src/db.js'] },
    in: { 'src/auth.js': ['src/api/routes.js'], 'src/db.js': ['src/api/routes.js'] },
  };

  const index = buildSyntheticIndex(entries, graph);

  // Independently derive the raw (pre-boost) BM25 order, using the exact
  // same building blocks rank() uses internally, to confirm the premise:
  // without any boost, 1:0 (db.js/connect) actually outscores 0:0 (auth.js/login).
  const rawDocs = entries.map((e) => ({ id: e.id, tokens: e.tokens }));
  const rawBm25 = buildBM25(rawDocs);
  const rawScores = scoreBM25(rawBm25, tokenize('login'));
  assert.ok(
    rawScores.get('1:0') > rawScores.get('0:0'),
    'premise check: raw BM25 must favor 1:0 over 0:0 before any boost is applied'
  );
  assert.equal(rawScores.has('3:0'), false, 'chunk with no "login" term must have no raw BM25 score');

  const results = rank(index, 'login', { top: 10 });

  // Only the three "login"-containing chunks may ever appear.
  assert.equal(results.length, 3);
  assert.ok(!results.some((r) => r.file === 'src/other.js'), 'unscored chunk must never appear');

  // Symbol boost flips the raw BM25 order: auth.js/login wins overall.
  assert.equal(results[0].file, 'src/auth.js');
  assert.equal(results[0].symbol, 'login');
  assertClose(results[0].score, rawScores.get('0:0') + 1.5 + 0.5, 'auth.js score: raw + symbol(1.5) + graph(0.5)');
  assert.deepEqual(results[0].reasons, [
    `bm25:${rawScores.get('0:0').toFixed(1)}`,
    'symbol:login',
    'graph:routes.js',
  ]);

  // db.js/connect: no symbol match (query "login" vs symbol "connect"), but
  // graph-boosted once (it's a neighbor of routes.js, itself a top-10 seed).
  const dbResult = results.find((r) => r.file === 'src/db.js');
  assert.ok(dbResult);
  assertClose(dbResult.score, rawScores.get('1:0') + 0.5, 'db.js score: raw + graph(0.5), no symbol boost');
  assert.deepEqual(dbResult.reasons, [`bm25:${rawScores.get('1:0').toFixed(1)}`, 'graph:routes.js']);

  // routes.js/registerRoutes: no symbol match either, graph-boosted once
  // (neighbor of auth.js, also a top-10 seed).
  const routesResult = results.find((r) => r.file === 'src/api/routes.js');
  assert.ok(routesResult);
  assertClose(routesResult.score, rawScores.get('2:0') + 0.5, 'routes.js score: raw + graph(0.5), no symbol boost');
  assert.deepEqual(routesResult.reasons, [`bm25:${rawScores.get('2:0').toFixed(1)}`, 'graph:auth.js']);
});

// ---------------------------------------------------------------------------
// Synthetic: symbol boost cap (+3.0 max per chunk) and per-match reasons.
// ---------------------------------------------------------------------------

test('rank(): symbol boost is capped at +3.0 even when 3+ subtokens match, but every match still gets its own reason entry', () => {
  const entries = [
    { id: '0:0', tokens: ['foo', 'bar', 'baz'], file: 'src/x.js', startLine: 1, endLine: 5, symbol: 'fooBarBaz' },
  ];
  const index = buildSyntheticIndex(entries);

  const rawBm25 = buildBM25([{ id: '0:0', tokens: ['foo', 'bar', 'baz'] }]);
  const rawScores = scoreBM25(rawBm25, tokenize('foo bar baz'));
  const raw = rawScores.get('0:0');
  assert.ok(raw > 0);

  const results = rank(index, 'foo bar baz', { top: 5 });
  assert.equal(results.length, 1);

  // 3 matched subtokens * 1.5 = 4.5, capped down to 3.0.
  assertClose(results[0].score, raw + 3.0, 'symbol boost must be capped at +3.0, not the uncapped 4.5');
  assert.deepEqual(results[0].reasons, [
    `bm25:${raw.toFixed(1)}`,
    'symbol:foo',
    'symbol:bar',
    'symbol:baz',
  ]);
});

test('rank(): a query with only two matching subtokens boosts by exactly 1.5 per match (under the cap)', () => {
  const entries = [
    { id: '0:0', tokens: ['user', 'id'], file: 'src/x.js', startLine: 1, endLine: 5, symbol: 'getUserID' },
  ];
  const index = buildSyntheticIndex(entries);

  const rawBm25 = buildBM25([{ id: '0:0', tokens: ['user', 'id'] }]);
  const rawScores = scoreBM25(rawBm25, tokenize('user id'));
  const raw = rawScores.get('0:0');

  const results = rank(index, 'user id', { top: 5 });
  assertClose(results[0].score, raw + 3.0, '2 matches * 1.5 = 3.0 exactly (at, not over, the cap)');
  assert.deepEqual(results[0].reasons, [`bm25:${raw.toFixed(1)}`, 'symbol:user', 'symbol:id']);
});

test('rank(): repeated matching query subtokens each contribute up to the +3 symbol cap', () => {
  const entries = [
    { id: '0:0', tokens: ['login'], file: 'src/auth.js', startLine: 1, endLine: 3, symbol: 'login' },
  ];
  const index = buildSyntheticIndex(entries);
  const raw = scoreBM25(index.bm25, tokenize('login login')).get('0:0');

  const [result] = rank(index, 'login login');
  assertClose(result.score, raw + 3.0, 'two matching query tokens must contribute 2 * 1.5');
  assert.deepEqual(result.reasons, [
    `bm25:${raw.toFixed(1)}`,
    'symbol:login',
    'symbol:login',
  ]);
});

// ---------------------------------------------------------------------------
// Synthetic: graph boost is applied at most once per chunk, and never to a
// chunk with no positive BM25 score of its own.
// ---------------------------------------------------------------------------

test('rank(): graph proximity boost is applied exactly once per chunk even when reachable from multiple seeds, and never introduces an unscored chunk', () => {
  const entries = [
    { id: '0:0', tokens: ['deploy'], file: 'fileA.js', startLine: 1, endLine: 3, symbol: null },
    { id: '1:0', tokens: ['deploy'], file: 'fileB.js', startLine: 1, endLine: 3, symbol: null },
    { id: '2:0', tokens: ['deploy'], file: 'fileC.js', startLine: 1, endLine: 3, symbol: null },
    // Neighbor of fileA via an edge, but shares no query term at all.
    { id: '3:0', tokens: ['unrelated'], file: 'fileD.js', startLine: 1, endLine: 3, symbol: null },
  ];

  // fileA and fileB both import fileC (so fileC is a neighbor of two seeds),
  // and fileA also imports fileD (unscored).
  const graph = {
    out: { 'fileA.js': ['fileC.js', 'fileD.js'], 'fileB.js': ['fileC.js'] },
    in: { 'fileC.js': ['fileA.js', 'fileB.js'], 'fileD.js': ['fileA.js'] },
  };

  const index = buildSyntheticIndex(entries, graph);
  const rawBm25 = buildBM25(entries.map((e) => ({ id: e.id, tokens: e.tokens })));
  const rawScores = scoreBM25(rawBm25, tokenize('deploy'));

  const results = rank(index, 'deploy', { top: 10 });

  // fileD.js has zero "deploy" term overlap; being a graph neighbor of a
  // scored seed (fileA.js) must not be enough to introduce it.
  assert.equal(results.length, 3, 'only the 3 chunks with a positive raw BM25 score may appear');
  assert.ok(!results.some((r) => r.file === 'fileD.js'));

  const fileC = results.find((r) => r.file === 'fileC.js');
  assert.ok(fileC);
  // fileC is a neighbor of BOTH fileA and fileB (both seeds) but must only
  // receive the +0.5 boost once, not once per contributing seed.
  assertClose(fileC.score, rawScores.get('2:0') + 0.5, 'graph boost must apply exactly once, not once per seed');
  assert.equal(fileC.reasons.filter((r) => r.startsWith('graph:')).length, 1);
});

// ---------------------------------------------------------------------------
// Synthetic: the graph boost only seeds from the top 10 chunks by score
// (SPEC clarification #6) — an 11th/12th-ranked chunk's own neighbors must
// not receive the boost, while a top-10 chunk's neighbor does.
// ---------------------------------------------------------------------------

test('rank(): graph-proximity boost seeds only from the top 10 scored chunks, not from lower-ranked ones', () => {
  // 12 chunks, all with identical tokens/tf/doc-length, so their raw BM25
  // scores are exactly tied and the only thing determining rank order is the
  // deterministic (file asc, startLine asc) tie-break — fully controlled via
  // file naming below, with no BM25 arithmetic guesswork needed.
  const entries = [];
  for (let i = 1; i <= 12; i++) {
    const n = String(i).padStart(2, '0');
    entries.push({ id: `${i}:0`, tokens: ['target'], file: `f${n}.js`, startLine: 1, endLine: 3, symbol: null });
  }
  // friend.js: neighbor of f01.js, which IS in the top 10 (rank 1st).
  entries.push({ id: '100:0', tokens: ['target'], file: 'friend.js', startLine: 1, endLine: 3, symbol: null });
  // hub.js / hub2.js: neighbors of f11.js / f12.js, which are rank 11/12 —
  // outside the top-10 seed window.
  entries.push({ id: '101:0', tokens: ['target'], file: 'hub.js', startLine: 1, endLine: 3, symbol: null });
  entries.push({ id: '102:0', tokens: ['target'], file: 'hub2.js', startLine: 1, endLine: 3, symbol: null });

  // Sanity-check the tie-break premise before relying on it: f01..f12 sort
  // ascending in exactly numeric order, and land before friend/hub/hub2.
  const filesInOrder = entries.map((e) => e.file);
  const sorted = [...filesInOrder].sort();
  assert.deepEqual(
    sorted.slice(0, 10),
    ['f01.js', 'f02.js', 'f03.js', 'f04.js', 'f05.js', 'f06.js', 'f07.js', 'f08.js', 'f09.js', 'f10.js'],
    'premise: the top 10 files in ascending order must be exactly f01.js..f10.js'
  );

  const graph = {
    out: { 'f01.js': ['friend.js'], 'f11.js': ['hub.js'], 'f12.js': ['hub2.js'] },
    in: { 'friend.js': ['f01.js'], 'hub.js': ['f11.js'], 'hub2.js': ['f12.js'] },
  };

  const index = buildSyntheticIndex(entries, graph);
  const results = rank(index, 'target', { top: 20 });
  assert.equal(results.length, 15);

  const baseline = results.find((r) => r.file === 'f05.js').score; // any tied, non-neighbor chunk
  const friend = results.find((r) => r.file === 'friend.js');
  const hub = results.find((r) => r.file === 'hub.js');
  const hub2 = results.find((r) => r.file === 'hub2.js');

  // friend.js's only seed (f01.js) IS in the top 10 -> boosted.
  assertClose(friend.score, baseline + 0.5, 'friend.js must be boosted: its seed f01.js is in the top 10');
  assert.ok(friend.reasons.includes('graph:f01.js'));

  // hub.js / hub2.js's seeds (f11.js / f12.js) are ranked 11th/12th -> NOT
  // among the top-10 seeds, so no boost reaches them despite the edge existing.
  assertClose(hub.score, baseline, 'hub.js must NOT be boosted: its only seed f11.js is outside the top 10');
  assertClose(hub2.score, baseline, 'hub2.js must NOT be boosted: its only seed f12.js is outside the top 10');
  assert.ok(!hub.reasons.some((r) => r.startsWith('graph:')));
  assert.ok(!hub2.reasons.some((r) => r.startsWith('graph:')));
});

// ---------------------------------------------------------------------------
// Synthetic: deterministic tie-break (score desc, then file asc, then
// startLine asc) — SPEC.md step 5.
// ---------------------------------------------------------------------------

test('rank(): equal-score chunks tie-break by file path ascending', () => {
  const entries = [
    { id: '0:0', tokens: ['apple'], file: 'b/file.js', startLine: 10, endLine: 12, symbol: null },
    { id: '1:0', tokens: ['apple'], file: 'a/file.js', startLine: 5, endLine: 7, symbol: null },
  ];
  const index = buildSyntheticIndex(entries);

  const results = rank(index, 'apple');
  assert.equal(results.length, 2);
  assertClose(results[0].score, results[1].score, 'both chunks must have identical scores (same tf/dl)');
  assert.deepEqual(results.map((r) => r.file), ['a/file.js', 'b/file.js']);
});

test('rank(): equal-score chunks in the SAME file tie-break by startLine ascending', () => {
  const entries = [
    { id: '0:0', tokens: ['apple'], file: 'same.js', startLine: 20, endLine: 22, symbol: null },
    { id: '0:1', tokens: ['apple'], file: 'same.js', startLine: 5, endLine: 7, symbol: null },
  ];
  const index = buildSyntheticIndex(entries);

  const results = rank(index, 'apple');
  assert.deepEqual(results.map((r) => r.startLine), [5, 20]);
});

// ---------------------------------------------------------------------------
// Synthetic: top-N slicing — default (20) and custom opts.top.
// ---------------------------------------------------------------------------

test('rank(): defaults to returning at most the top 20 results, in the same order scoreBM25 + tie-break would produce', () => {
  const entries = [];
  for (let i = 0; i < 25; i++) {
    const n = String(i).padStart(2, '0');
    // Distinct tf (and matching doc length) per chunk so scores differ.
    entries.push({
      id: `${i}:0`,
      tokens: Array(i + 1).fill('common'),
      file: `f${n}.js`,
      startLine: 1,
      endLine: 3,
      symbol: null,
    });
  }
  const index = buildSyntheticIndex(entries);

  // Derive the expected order independently, from the same building blocks,
  // rather than hand-computing/guessing 25 BM25 scores.
  const rawBm25 = buildBM25(entries.map((e) => ({ id: e.id, tokens: e.tokens })));
  const rawScores = scoreBM25(rawBm25, tokenize('common'));
  const metaById = new Map(entries.map((e) => [e.id, e]));

  const expectedOrder = [...rawScores.keys()].sort((a, b) => {
    const diff = rawScores.get(b) - rawScores.get(a);
    if (diff !== 0) return diff;
    const fa = metaById.get(a).file;
    const fb = metaById.get(b).file;
    if (fa !== fb) return fa < fb ? -1 : 1;
    return metaById.get(a).startLine - metaById.get(b).startLine;
  });

  const defaultResults = rank(index, 'common');
  assert.equal(defaultResults.length, 20, 'default top must be 20');
  assert.deepEqual(
    defaultResults.map((r) => r.file),
    expectedOrder.slice(0, 20).map((id) => metaById.get(id).file)
  );

  const top5 = rank(index, 'common', { top: 5 });
  assert.equal(top5.length, 5);
  assert.deepEqual(
    top5.map((r) => r.file),
    expectedOrder.slice(0, 5).map((id) => metaById.get(id).file)
  );

  const top1000 = rank(index, 'common', { top: 1000 });
  assert.equal(top1000.length, 25, 'opts.top larger than the scored set must not pad the result, just return all of it');
});

// ---------------------------------------------------------------------------
// No-match queries.
// ---------------------------------------------------------------------------

test('rank(): a query with no vocabulary overlap at all returns an empty array', () => {
  const entries = [
    { id: '0:0', tokens: ['login'], file: 'src/auth.js', startLine: 1, endLine: 3, symbol: 'login' },
  ];
  const index = buildSyntheticIndex(entries);

  assert.deepEqual(rank(index, 'zzzznomatchxyz'), []);
});

test('rank(): an empty task string returns an empty array', () => {
  const entries = [
    { id: '0:0', tokens: ['login'], file: 'src/auth.js', startLine: 1, endLine: 3, symbol: 'login' },
  ];
  const index = buildSyntheticIndex(entries);

  assert.deepEqual(rank(index, ''), []);
});

test('rank(): invalid top values fail clearly instead of producing misleading slices', () => {
  const index = buildSyntheticIndex([
    { id: '0:0', tokens: ['login'], file: 'a.js', startLine: 1, endLine: 1, symbol: null },
  ]);
  for (const top of [-1, 1.5, NaN, Infinity]) {
    assert.throws(() => rank(index, 'login', { top }), /top must be a non-negative integer/);
  }
});
