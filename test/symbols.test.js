// test/symbols.test.js
//
// Exercises src/symbols.js (extractSymbols) against:
//   1. The real fixtures/sample repo files (grounded in SPEC's guaranteed
//      assertions: auth.js names, migrate.py's `migrate`).
//   2. Synthetic snippets for language/kind coverage that the fixture repo
//      doesn't happen to exercise (TS `type`/`interface`, `other` kind,
//      generic-language fallback rules, empty/no-match input).
//
// extractSymbols is pure (text in, array out) so most cases just need a
// string — no repo needed. Fixture-grounded cases read the real fixture
// files from disk via an absolute path resolved from this test file's own
// location (fileURLToPath(import.meta.url)), per SPEC's test conventions.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractSymbols } from '../src/symbols.js';
import { detectLang, LANG_RULES } from '../src/lang.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.resolve(__dirname, '..', 'fixtures', 'sample');

async function readFixture(relPosixPath) {
  const abs = path.join(FIXTURE_ROOT, ...relPosixPath.split('/'));
  const text = await readFile(abs, 'utf8');
  return { text, lang: detectLang(relPosixPath) };
}

// ---------------------------------------------------------------------------
// Fixture-grounded assertions (SPEC "Guaranteed assertions" + full lock-down
// of the real, on-disk fixture content since it's deterministic).
// ---------------------------------------------------------------------------

test('auth.js: symbols include login, logout, TOKEN_TTL with correct kind/line (SPEC guarantee)', async () => {
  const { text, lang } = await readFixture('src/auth.js');
  assert.equal(lang, 'js');
  const symbols = extractSymbols(text, lang);

  const byName = Object.fromEntries(symbols.map((s) => [s.name, s]));
  assert.ok('login' in byName, 'expected a "login" symbol');
  assert.ok('logout' in byName, 'expected a "logout" symbol');
  assert.ok('TOKEN_TTL' in byName, 'expected a "TOKEN_TTL" symbol');

  assert.equal(byName.login.kind, 'function');
  assert.equal(byName.login.line, 3);
  assert.equal(byName.logout.kind, 'function');
  assert.equal(byName.logout.line, 10);
  assert.equal(byName.TOKEN_TTL.kind, 'const');
  assert.equal(byName.TOKEN_TTL.line, 14);

  // Full lock-down: exactly these three, nothing else, in file order.
  assert.deepEqual(
    symbols.map((s) => [s.name, s.kind, s.line]),
    [
      ['login', 'function', 3],
      ['logout', 'function', 10],
      ['TOKEN_TTL', 'const', 14],
    ]
  );
});

test('auth.js: endLine best-effort boundaries (next symbol - 1 / EOF for the last)', async () => {
  const { text, lang } = await readFixture('src/auth.js');
  const symbols = extractSymbols(text, lang);
  const totalLines = text.split('\n').length;

  const [login, logout, tokenTtl] = symbols;
  assert.equal(login.endLine, logout.line - 1);
  assert.equal(logout.endLine, tokenTtl.line - 1);
  // Last symbol in the file runs to EOF (text.split('\n').length, matching
  // the doc comment's "totalLines" semantics, including the trailing-newline
  // synthetic empty last element).
  assert.equal(tokenTtl.endLine, totalLines);
});

test('db.js: class + method extraction, and endLine demonstrates NO brace/indent matching', async () => {
  const { text, lang } = await readFixture('src/db.js');
  const symbols = extractSymbols(text, lang);

  assert.deepEqual(
    symbols.map((s) => [s.name, s.kind, s.line]),
    [
      ['Database', 'class', 3],
      ['connect', 'method', 4],
      ['query', 'method', 9],
    ]
  );

  const [dbClass, connect, query] = symbols;
  // Best-effort boundary: the class's endLine is only "up to just before the
  // next detected symbol" (its own first method on the very next line), NOT
  // the closing brace of the class body. This is the documented lack of
  // brace/indent tracking, not a bug.
  assert.equal(dbClass.line, 3);
  assert.equal(dbClass.endLine, 3);
  assert.equal(connect.endLine, query.line - 1);
  assert.equal(query.endLine, text.split('\n').length);
});

test('routes.js: registerRoutes is found; line-based matching also picks up nested const bindings (no scope awareness)', async () => {
  const { text, lang } = await readFixture('src/api/routes.js');
  const symbols = extractSymbols(text, lang);

  const registerRoutes = symbols.find((s) => s.name === 'registerRoutes');
  assert.ok(registerRoutes, 'expected a "registerRoutes" symbol');
  assert.equal(registerRoutes.kind, 'function');
  assert.equal(registerRoutes.line, 6);

  // extractSymbols matches line-by-line with no brace/scope tracking, so
  // `const db = ...` and `const result = ...` inside the function body are
  // also picked up as top-level-looking `const` symbols. This locks down
  // that documented (non-)behavior rather than assuming naive scoping.
  assert.deepEqual(
    symbols.map((s) => [s.name, s.kind, s.line]),
    [
      ['registerRoutes', 'function', 6],
      ['db', 'const', 7],
      ['result', 'const', 11],
    ]
  );
});

test('migrate.py: symbols include `migrate` with kind "def" (SPEC guarantee)', async () => {
  const { text, lang } = await readFixture('scripts/migrate.py');
  assert.equal(lang, 'py');
  const symbols = extractSymbols(text, lang);

  assert.equal(symbols.length, 1);
  assert.equal(symbols[0].name, 'migrate');
  assert.equal(symbols[0].kind, 'def');
  assert.equal(symbols[0].line, 4);
  assert.equal(symbols[0].endLine, text.split('\n').length);
});

// ---------------------------------------------------------------------------
// Kind coverage the fixture repo doesn't happen to exercise: "type" (TS
// interface/type) and "other" (export-default-identifier, module.exports.x=).
// ---------------------------------------------------------------------------

test('TS: interface and type declarations produce kind "type"', () => {
  const text = [
    'export interface Foo {',
    '  bar: string;',
    '}',
    '',
    'export type Bar = string | number;',
  ].join('\n');

  const symbols = extractSymbols(text, 'ts');
  assert.deepEqual(
    symbols.map((s) => [s.name, s.kind, s.line]),
    [
      ['Foo', 'type', 1],
      ['Bar', 'type', 5],
    ]
  );
});

test('JS: export-default-identifier and module.exports.x= both produce kind "other"', () => {
  const text = [
    'module.exports.baz = function () {};',
    '',
    'export default qux;',
  ].join('\n');

  const symbols = extractSymbols(text, 'js');
  assert.deepEqual(
    symbols.map((s) => [s.name, s.kind, s.line]),
    [
      ['baz', 'other', 1],
      ['qux', 'other', 3],
    ]
  );
});

test('JS/TS: arrow functions with one unparenthesized parameter are symbols', () => {
  const text = [
    'const identity = value => value;',
    'export const later = async item => item;',
  ].join('\n');

  assert.deepEqual(
    extractSymbols(text, 'js').map((s) => [s.name, s.kind, s.line]),
    [
      ['identity', 'function', 1],
      ['later', 'function', 2],
    ]
  );
});

test('TS: class methods with return annotations are symbols', () => {
  const text = [
    'class Service {',
    '  lookup(id: string): Promise<string> {',
    '    return Promise.resolve(id);',
    '  }',
    '}',
  ].join('\n');

  assert.deepEqual(
    extractSymbols(text, 'ts').map((s) => [s.name, s.kind, s.line]),
    [
      ['Service', 'class', 1],
      ['lookup', 'method', 2],
    ]
  );
});

// ---------------------------------------------------------------------------
// LANG_RULES total coverage: every lang detectLang() can return must have a
// defined symbolPatterns entry, jsx/tsx must reuse js/ts verbatim, and every
// other non-bespoke language must share ONE generic rule object (clarification
// #3). extractSymbols must not throw for any of them.
// ---------------------------------------------------------------------------

test('extractSymbols does not throw and returns an array for every detectLang() output', () => {
  const allLangs = ['js', 'ts', 'jsx', 'tsx', 'py', 'go', 'rust', 'java', 'rb', 'php', 'c', 'cpp', 'cs', 'text'];
  for (const lang of allLangs) {
    assert.ok(LANG_RULES[lang], `LANG_RULES must define a rule set for "${lang}"`);
    const result = extractSymbols('hello world\n', lang);
    assert.ok(Array.isArray(result), `extractSymbols(text, "${lang}") should return an array`);
  }
});

test('jsx/tsx reuse the js/ts symbol patterns verbatim (same rule object)', () => {
  assert.equal(LANG_RULES.jsx.symbolPatterns, LANG_RULES.js.symbolPatterns);
  assert.equal(LANG_RULES.tsx.symbolPatterns, LANG_RULES.ts.symbolPatterns);
});

test('generic-language fallback: same patterns catch function/class shapes across go/rust/java', () => {
  const goSymbols = extractSymbols('package main\n\nfunc Foo() {\n  return\n}\n', 'go');
  assert.deepEqual(goSymbols.map((s) => [s.name, s.kind]), [['Foo', 'function']]);

  const rustSymbols = extractSymbols('fn add(a: i32, b: i32) -> i32 {\n  a + b\n}\n', 'rust');
  assert.deepEqual(rustSymbols.map((s) => [s.name, s.kind]), [['add', 'function']]);

  const javaSymbols = extractSymbols('public class Greeter {\n  public void hello() {}\n}\n', 'java');
  assert.deepEqual(javaSymbols.map((s) => [s.name, s.kind]), [['Greeter', 'class']]);

  // All three langs without bespoke rules must be backed by the exact same
  // generic rule object instance (not just equivalent copies).
  assert.equal(LANG_RULES.go.symbolPatterns, LANG_RULES.rust.symbolPatterns);
  assert.equal(LANG_RULES.rust.symbolPatterns, LANG_RULES.java.symbolPatterns);
});

// ---------------------------------------------------------------------------
// Edge cases: empty input, no-match input, and the general (name,line)
// uniqueness + non-decreasing line-order invariants across everything above.
// ---------------------------------------------------------------------------

test('extractSymbols returns [] for empty text and for text with no matching declarations', () => {
  assert.deepEqual(extractSymbols('', 'js'), []);
  assert.deepEqual(extractSymbols('just some prose\nwith no code at all\n', 'text'), []);
});

test('extractSymbols output is deduped by (name,line) and sorted by non-decreasing line, across every case above', async () => {
  const cases = [
    await readFixture('src/auth.js'),
    await readFixture('src/db.js'),
    await readFixture('src/util.js'),
    await readFixture('src/api/routes.js'),
    await readFixture('scripts/migrate.py'),
  ];

  for (const { text, lang } of cases) {
    const symbols = extractSymbols(text, lang);
    const seen = new Set();
    let prevLine = 0;
    for (const sym of symbols) {
      const key = `${sym.name} ${sym.line}`;
      assert.ok(!seen.has(key), `duplicate (name,line) pair found: ${key}`);
      seen.add(key);
      assert.ok(sym.line >= prevLine, 'symbols must be in non-decreasing line order');
      prevLine = sym.line;
      assert.ok(sym.endLine >= sym.line, 'endLine must never be before line');
    }
  }
});
