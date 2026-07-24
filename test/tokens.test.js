// test/tokens.test.js
//
// Tests for src/tokens.js: estimateTokens (SPEC.md "Global conventions" —
// Math.ceil(text.length / 4) everywhere) and fitToBudget (SPEC.md
// clarification #8 — strict prefix semantics: stop at the FIRST item whose
// addition would push cumulative size above budget; that item and everything
// after it go to `dropped`, in original order; `used` sums only `included`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

import { estimateTokens, fitToBudget } from '../src/tokens.js';
import { readLines } from '../src/util.js';

const FIXTURE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'sample'
);
const AUTH_PATH = path.join(FIXTURE_ROOT, 'src', 'auth.js');

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

test('estimateTokens: empty string is 0 tokens', () => {
  assert.equal(estimateTokens(''), 0);
});

test('estimateTokens: exact multiples of 4 divide evenly (no rounding needed)', () => {
  assert.equal(estimateTokens('a'.repeat(4)), 1);
  assert.equal(estimateTokens('a'.repeat(8)), 2);
  assert.equal(estimateTokens('a'.repeat(40)), 10);
});

test('estimateTokens: non-multiples of 4 round UP (ceil, not floor/round)', () => {
  // 1..3 chars -> 1 token; 5..7 -> 2 tokens; 9 -> 3 tokens.
  assert.equal(estimateTokens('a'), 1);
  assert.equal(estimateTokens('ab'), 1);
  assert.equal(estimateTokens('abc'), 1);
  assert.equal(estimateTokens('abcde'), 2);
  assert.equal(estimateTokens('abcdefg'), 2);
  assert.equal(estimateTokens('abcdefghi'), 3);
});

test('estimateTokens: matches Math.ceil(text.length / 4) exactly for arbitrary lengths', () => {
  for (const len of [0, 1, 2, 3, 4, 5, 17, 99, 100, 101, 4096]) {
    const text = 'x'.repeat(len);
    assert.equal(estimateTokens(text), Math.ceil(len / 4), `length ${len}`);
  }
});

test('estimateTokens: grounded in the real fixture — auth.js header comment line', async () => {
  // Line 1 of fixtures/sample/src/auth.js per SPEC.md's fixture guarantees;
  // 79 chars (includes the em dash), so ceil(79/4) = 20.
  const header = await readLines(AUTH_PATH, 1, 1);
  assert.equal(header.length, 79);
  assert.equal(estimateTokens(header), 20);
});

test('estimateTokens: grounded in the real fixture — whole auth.js file', async () => {
  const whole = await readFile(AUTH_PATH, 'utf8');
  assert.equal(estimateTokens(whole), Math.ceil(whole.length / 4));
  // Pin the concrete value too, so a change in the fixture or in the formula
  // both surface as a test failure rather than silently drifting.
  assert.equal(estimateTokens(whole), 81);
});

// ---------------------------------------------------------------------------
// fitToBudget — basic accounting
// ---------------------------------------------------------------------------

test('fitToBudget: empty items array yields empty included/dropped and used=0', () => {
  const result = fitToBudget([], 100, () => 10);
  assert.deepEqual(result, { included: [], dropped: [], used: 0 });
});

test('fitToBudget: everything fits when budget comfortably exceeds the total', () => {
  const items = [1, 2, 3, 4];
  const result = fitToBudget(items, 1000, (n) => n * 10);
  assert.deepEqual(result.included, items);
  assert.deepEqual(result.dropped, []);
  assert.equal(result.used, 100); // (1+2+3+4)*10
});

test('fitToBudget: budget of 0 with any positive-size item drops everything', () => {
  const items = ['a', 'b', 'c'];
  const result = fitToBudget(items, 0, () => 5);
  assert.deepEqual(result.included, []);
  assert.deepEqual(result.dropped, ['a', 'b', 'c']);
  assert.equal(result.used, 0);
});

test('fitToBudget: boundary — cumulative size exactly equal to budget is included (not >=)', () => {
  // used+size > budget is the cutoff, so used+size === budget must still be included.
  const items = ['x', 'y'];
  const sizes = { x: 10, y: 10 };
  const result = fitToBudget(items, 20, (item) => sizes[item]);
  assert.deepEqual(result.included, ['x', 'y']);
  assert.deepEqual(result.dropped, []);
  assert.equal(result.used, 20);
});

test('fitToBudget: boundary — one token over budget tips the item into dropped', () => {
  const items = ['x', 'y'];
  const sizes = { x: 10, y: 11 };
  const result = fitToBudget(items, 20, (item) => sizes[item]);
  assert.deepEqual(result.included, ['x']);
  assert.deepEqual(result.dropped, ['y']);
  assert.equal(result.used, 10);
});

// ---------------------------------------------------------------------------
// fitToBudget — strict prefix-stop semantics (SPEC clarification #8)
//
// This is the behavior that distinguishes fitToBudget from a knapsack/
// best-fit packer: once an item would overflow the budget, ALL subsequent
// items are dropped too, even if a later, smaller item would have fit in the
// remaining space. We ground this in real chunk-sized token counts pulled
// from the auth.js fixture so the test reflects how pack.js actually uses it.
// ---------------------------------------------------------------------------

test('fitToBudget: a big item that overflows also drops smaller items after it (no best-fit backfill)', async () => {
  // Real line-range token counts from fixtures/sample/src/auth.js:
  //   header (L1)        -> 20 tokens
  //   login() body (L3-8)-> 39 tokens
  //   logout() body(L10-12) -> 13 tokens
  //   TOKEN_TTL (L14)     -> 8 tokens
  const header = await readLines(AUTH_PATH, 1, 1);
  const loginBody = await readLines(AUTH_PATH, 3, 8);
  const logoutBody = await readLines(AUTH_PATH, 10, 12);
  const ttlLine = await readLines(AUTH_PATH, 14, 14);

  assert.equal(estimateTokens(header), 20);
  assert.equal(estimateTokens(loginBody), 39);
  assert.equal(estimateTokens(logoutBody), 13);
  assert.equal(estimateTokens(ttlLine), 8);

  const items = [header, loginBody, logoutBody, ttlLine];
  // Budget fits header (20) but not header+loginBody (20+39=59). Even though
  // logoutBody (13) and ttlLine (8) would both fit in the 30 tokens left
  // after header alone, a true prefix-stop packer must drop them anyway
  // because they appear after the overflowing loginBody.
  const budget = 50;
  const result = fitToBudget(items, budget, estimateTokens);

  assert.deepEqual(result.included, [header]);
  assert.deepEqual(result.dropped, [loginBody, logoutBody, ttlLine]);
  assert.equal(result.used, 20);
  assert.ok(result.used <= budget);
});

test('fitToBudget: dropped items preserve original order after the overflow point', async () => {
  const header = await readLines(AUTH_PATH, 1, 1); // 20
  const loginBody = await readLines(AUTH_PATH, 3, 8); // 39
  const logoutBody = await readLines(AUTH_PATH, 10, 12); // 13
  const ttlLine = await readLines(AUTH_PATH, 14, 14); // 8

  const items = [header, loginBody, logoutBody, ttlLine];
  // budget = 59 lets header+loginBody through exactly (20+39=59, not >59);
  // logoutBody then overflows (59+13=72>59) and everything after it drops.
  const result = fitToBudget(items, 59, estimateTokens);

  assert.deepEqual(result.included, [header, loginBody]);
  assert.deepEqual(result.dropped, [logoutBody, ttlLine]);
  assert.equal(result.used, 59);
});

// ---------------------------------------------------------------------------
// fitToBudget — used to structured pack-like items (SPEC clarification #9:
// pack.js's included entries carry a `.tokens` field and sizeFn reads that)
// ---------------------------------------------------------------------------

test('fitToBudget: works with structured {file, tokens} items and a field-accessor sizeFn', () => {
  const items = [
    { file: 'src/auth.js', tokens: 20 },
    { file: 'src/db.js', tokens: 30 },
    { file: 'src/util.js', tokens: 25 },
  ];
  const result = fitToBudget(items, 45, (item) => item.tokens);

  assert.deepEqual(result.included, [{ file: 'src/auth.js', tokens: 20 }]);
  assert.deepEqual(result.dropped, [
    { file: 'src/db.js', tokens: 30 },
    { file: 'src/util.js', tokens: 25 },
  ]);
  assert.equal(result.used, 20);
});

test('fitToBudget: sizeFn is invoked with each item so a stateful/derived accessor still accumulates correctly', () => {
  const items = ['a', 'bb', 'ccc', 'dddd']; // lengths 1,2,3,4
  const result = fitToBudget(items, 6, (item) => item.length);

  // Cumulative: 1 (ok, used=1), +2=3 (ok, used=3), +3=6 (ok, used=6), +4=10>6 (stop)
  assert.deepEqual(result.included, ['a', 'bb', 'ccc']);
  assert.deepEqual(result.dropped, ['dddd']);
  assert.equal(result.used, 6);
});
