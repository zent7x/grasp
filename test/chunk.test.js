// test/chunk.test.js
//
// Unit tests for src/chunk.js: chunkFile() must produce a gapless,
// non-overlapping partition of a file's lines, preferring symbol boundaries
// and falling back to fixed-size windows. chunkFile is documented as a pure
// function (no disk, no imports), so most cases here are synthetic. The
// remaining cases integrate with the real extractSymbols()/detectLang()
// output on fixtures/sample to ground the assertions in the fixture
// guarantees pinned by SPEC.md.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { chunkFile } from '../src/chunk.js';
import { extractSymbols } from '../src/symbols.js';
import { detectLang } from '../src/lang.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.resolve(__dirname, '..', 'fixtures', 'sample');

/**
 * Assert that `chunks` is sorted, gapless, non-overlapping, and covers
 * exactly [1, totalLines] with 1-based inclusive ranges.
 */
function assertGaplessPartition(chunks, totalLines, label) {
  assert.ok(chunks.length > 0, `${label}: expected at least one chunk`);
  let cursor = 1;
  for (const c of chunks) {
    assert.equal(
      c.startLine,
      cursor,
      `${label}: chunk should start exactly at cursor ${cursor}, got ${c.startLine} (chunk=${JSON.stringify(c)})`
    );
    assert.ok(c.endLine >= c.startLine, `${label}: endLine >= startLine for ${JSON.stringify(c)}`);
    cursor = c.endLine + 1;
  }
  assert.equal(
    cursor - 1,
    totalLines,
    `${label}: chunks should cover up through totalLines=${totalLines}, actually ended at ${cursor - 1}`
  );
}

async function loadFixture(relPath) {
  const abs = path.join(FIXTURE_ROOT, relPath);
  const text = await readFile(abs, 'utf8');
  const lang = detectLang(relPath);
  return { text, lang };
}

describe('chunkFile - synthetic pure-function behavior', () => {
  test('single-line file with no symbols yields one null-symbol chunk', () => {
    const chunks = chunkFile('hello', [], { chunkMaxLines: 60 });
    assert.deepEqual(chunks, [{ startLine: 1, endLine: 1, symbol: null }]);
  });

  test('empty string still yields one chunk covering the sole line', () => {
    const chunks = chunkFile('', [], { chunkMaxLines: 60 });
    assert.deepEqual(chunks, [{ startLine: 1, endLine: 1, symbol: null }]);
  });

  test('an un-symboled region is windowed by chunkMaxLines', () => {
    const text = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n');
    const chunks = chunkFile(text, [], { chunkMaxLines: 4 });
    assert.deepEqual(chunks, [
      { startLine: 1, endLine: 4, symbol: null },
      { startLine: 5, endLine: 8, symbol: null },
      { startLine: 9, endLine: 10, symbol: null },
    ]);
  });

  test('a symbol longer than chunkMaxLines splits into consecutive same-named windows', () => {
    const text = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n');
    const symbols = [{ name: 'big', kind: 'function', line: 1, endLine: 10 }];
    const chunks = chunkFile(text, symbols, { chunkMaxLines: 3 });
    assert.deepEqual(chunks, [
      { startLine: 1, endLine: 3, symbol: 'big' },
      { startLine: 4, endLine: 6, symbol: 'big' },
      { startLine: 7, endLine: 9, symbol: 'big' },
      { startLine: 10, endLine: 10, symbol: 'big' },
    ]);
    assertGaplessPartition(chunks, 10, 'split-symbol');
  });

  test('leading gap + symbol + trailing gap all cover the file with no overlap', () => {
    const text = Array.from({ length: 12 }, (_, i) => `line${i + 1}`).join('\n');
    const symbols = [{ name: 'foo', kind: 'function', line: 4, endLine: 6 }];
    const chunks = chunkFile(text, symbols, { chunkMaxLines: 60 });
    assert.deepEqual(chunks, [
      { startLine: 1, endLine: 3, symbol: null },
      { startLine: 4, endLine: 6, symbol: 'foo' },
      { startLine: 7, endLine: 12, symbol: null },
    ]);
  });

  test('overlapping symbols: the later-starting symbol is clipped to the cursor left by the earlier one', () => {
    const text = Array.from({ length: 9 }, (_, i) => `line${i + 1}`).join('\n');
    const symbols = [
      { name: 'a', kind: 'function', line: 1, endLine: 5 },
      { name: 'b', kind: 'function', line: 3, endLine: 8 }, // overlaps a's range
    ];
    const chunks = chunkFile(text, symbols, { chunkMaxLines: 60 });
    assert.deepEqual(chunks, [
      { startLine: 1, endLine: 5, symbol: 'a' },
      { startLine: 6, endLine: 8, symbol: 'b' },
      { startLine: 9, endLine: 9, symbol: null },
    ]);
    assertGaplessPartition(chunks, 9, 'overlap-clip');
  });

  test('a symbol fully engulfed by a preceding symbol contributes no chunk of its own', () => {
    const text = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n');
    const symbols = [
      { name: 'outer', kind: 'function', line: 1, endLine: 10 },
      { name: 'inner', kind: 'method', line: 3, endLine: 5 }, // fully inside outer
    ];
    const chunks = chunkFile(text, symbols, { chunkMaxLines: 60 });
    assert.deepEqual(chunks, [{ startLine: 1, endLine: 10, symbol: 'outer' }]);
    assert.ok(
      !chunks.some((c) => c.symbol === 'inner'),
      'an engulfed symbol must not surface as a separate chunk'
    );
  });

  test('invalid or omitted chunkMaxLines falls back to the 60-line default', () => {
    const text = Array.from({ length: 70 }, (_, i) => `line${i + 1}`).join('\n');
    const expected = [
      { startLine: 1, endLine: 60, symbol: null },
      { startLine: 61, endLine: 70, symbol: null },
    ];
    assert.deepEqual(chunkFile(text, [], undefined), expected, 'omitted opts');
    assert.deepEqual(chunkFile(text, [], {}), expected, 'opts without chunkMaxLines');
    assert.deepEqual(chunkFile(text, [], { chunkMaxLines: 0 }), expected, 'chunkMaxLines: 0');
    assert.deepEqual(chunkFile(text, [], { chunkMaxLines: -5 }), expected, 'chunkMaxLines: negative');
  });

  test('every chunk in the output is gapless/non-overlapping regardless of symbol shape', () => {
    const text = Array.from({ length: 37 }, (_, i) => `line${i + 1}`).join('\n');
    const symbols = [
      { name: 'one', kind: 'function', line: 2, endLine: 4 },
      { name: 'two', kind: 'function', line: 10, endLine: 33 }, // spans multiple windows at maxLines:5
      { name: 'three', kind: 'const', line: 35, endLine: 35 },
    ];
    const chunks = chunkFile(text, symbols, { chunkMaxLines: 5 });
    assertGaplessPartition(chunks, 37, 'mixed-shape');
    // "two" must have been split since its 24-line body exceeds chunkMaxLines:5.
    const twoWindows = chunks.filter((c) => c.symbol === 'two');
    assert.ok(twoWindows.length > 1, 'expected the long symbol to be split into multiple windows');
    for (const w of twoWindows) {
      assert.ok(w.endLine - w.startLine + 1 <= 5, 'no window should exceed chunkMaxLines');
    }
  });
});

describe('chunkFile - grounded in fixtures/sample', () => {
  test('auth.js: default chunking follows the login/logout/TOKEN_TTL symbol boundaries', async () => {
    const { text, lang } = await loadFixture('src/auth.js');
    assert.equal(lang, 'js');
    const symbols = extractSymbols(text, lang);
    assert.deepEqual(
      symbols.map((s) => s.name),
      ['login', 'logout', 'TOKEN_TTL']
    );

    const chunks = chunkFile(text, symbols, { chunkMaxLines: 60 });
    assert.deepEqual(chunks, [
      { startLine: 1, endLine: 2, symbol: null },
      { startLine: 3, endLine: 9, symbol: 'login' },
      { startLine: 10, endLine: 13, symbol: 'logout' },
      { startLine: 14, endLine: 15, symbol: 'TOKEN_TTL' },
    ]);
    assertGaplessPartition(chunks, text.split('\n').length, 'auth.js');
  });

  test('auth.js: a small chunkMaxLines splits the multi-line login() body into windows', async () => {
    const { text, lang } = await loadFixture('src/auth.js');
    const symbols = extractSymbols(text, lang);
    const chunks = chunkFile(text, symbols, { chunkMaxLines: 3 });

    const loginChunks = chunks.filter((c) => c.symbol === 'login');
    assert.ok(loginChunks.length > 1, 'the 7-line login() body should split across multiple windows');
    for (const c of loginChunks) {
      assert.ok(c.endLine - c.startLine + 1 <= 3, 'no login() window should exceed chunkMaxLines');
    }
    // logout()/TOKEN_TTL are short enough that windowing shouldn't fragment them unnecessarily,
    // but the whole-file partition invariant must still hold under the smaller window size.
    assertGaplessPartition(chunks, text.split('\n').length, 'auth.js (chunkMaxLines:3)');
  });

  test('db.js: the Database class and its methods each get their own chunk, whole file covered', async () => {
    const { text, lang } = await loadFixture('src/db.js');
    assert.equal(lang, 'js');
    const symbols = extractSymbols(text, lang);
    const symbolNames = symbols.map((s) => s.name);
    assert.ok(symbolNames.includes('Database'));
    assert.ok(symbolNames.includes('connect'));
    assert.ok(symbolNames.includes('query'));

    const chunks = chunkFile(text, symbols, { chunkMaxLines: 60 });
    assertGaplessPartition(chunks, text.split('\n').length, 'db.js');
    for (const name of ['Database', 'connect', 'query']) {
      assert.equal(
        chunks.filter((c) => c.symbol === name).length,
        1,
        `expected exactly one chunk tagged '${name}'`
      );
    }
  });

  test('routes.js: registerRoutes gets its own chunk and the file is fully covered', async () => {
    const { text, lang } = await loadFixture('src/api/routes.js');
    assert.equal(lang, 'js');
    const symbols = extractSymbols(text, lang);
    const chunks = chunkFile(text, symbols, { chunkMaxLines: 60 });
    assertGaplessPartition(chunks, text.split('\n').length, 'routes.js');

    const registerRoutesChunk = chunks.find((c) => c.symbol === 'registerRoutes');
    assert.ok(registerRoutesChunk, 'expected a chunk tagged registerRoutes');
    assert.equal(registerRoutesChunk.startLine, 6);
  });

  test('migrate.py: def migrate() is its own chunk; the leading import/blank lines form a null chunk', async () => {
    const { text, lang } = await loadFixture('scripts/migrate.py');
    assert.equal(lang, 'py');
    const symbols = extractSymbols(text, lang);
    assert.deepEqual(
      symbols.map((s) => s.name),
      ['migrate']
    );

    const chunks = chunkFile(text, symbols, { chunkMaxLines: 60 });
    assert.deepEqual(chunks, [
      { startLine: 1, endLine: 3, symbol: null },
      { startLine: 4, endLine: 9, symbol: 'migrate' },
    ]);
    assertGaplessPartition(chunks, text.split('\n').length, 'migrate.py');
  });
});
