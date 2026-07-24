// test/outline.test.js
//
// Tests for src/outline.js: outlineFile() renders a single indexed file
// record's symbol list; outlineRepo() renders a directory-grouped tree of
// the whole repo (or a subtree via opts.dir). Both are pure string
// formatters over already-built index data (no disk access).
//
// The bulk of these tests build the REAL index for fixtures/sample via
// src/index-build.js's buildIndex() (noSave:true so nothing touches disk),
// then feed the real file records straight into outline.js. That grounds
// the assertions in the fixture guarantees SPEC.md pins (auth.js's login/
// logout/TOKEN_TTL, db.js's Database class + connect/query methods,
// routes.js wiring, migrate.py's Python `def`) rather than hand-picked
// stand-ins, while still asserting the exact formatting contract described
// in outline.js's docstrings: `  kind name  (Lstart-Lend)` per symbol line,
// directories before files, ascending plain-string sort at every level, and
// opts.dir subtree restriction.
//
// A handful of tests also exercise outlineFile() against small hand-built
// fileRecord objects (not from buildIndex) to pin edge behavior the fixture
// alone can't demonstrate: preserved (non-re-sorted) symbol order, and the
// documented `fileRecord.symbols || []` fallback when symbols is omitted.

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { outlineFile, outlineRepo } from '../src/outline.js';
import { buildIndex } from '../src/index-build.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, '..', 'fixtures', 'sample');

// Built once: outline.js does no disk I/O of its own, and the fixture is
// immutable, so every test below can share one real index snapshot.
const index = await buildIndex(FIXTURE_ROOT, { noSave: true });

function fileRecord(relPath) {
  const rec = index.files.find((f) => f.path === relPath);
  assert.ok(rec, `expected fixture index to contain ${relPath}`);
  return rec;
}

// ---------------------------------------------------------------------------
// outlineFile
// ---------------------------------------------------------------------------

test('outlineFile(auth.js): path on line 1, then one "  kind name  (Lstart-Lend)" line per symbol, in symbol order', () => {
  const out = outlineFile(fileRecord('src/auth.js'));

  // Exact match: pins both the per-line format (kind, name, double-space
  // before the parenthesized range, 1-based inclusive L-numbers) and the
  // SPEC-guaranteed symbol set/order for auth.js (login, logout, TOKEN_TTL).
  assert.equal(
    out,
    [
      'src/auth.js',
      '  function login  (L3-L9)',
      '  function logout  (L10-L13)',
      '  const TOKEN_TTL  (L14-L15)',
    ].join('\n')
  );
});

test('outlineFile(db.js): class + method kinds render correctly, including a same-line class/method boundary', () => {
  const out = outlineFile(fileRecord('src/db.js'));

  assert.equal(
    out,
    [
      'src/db.js',
      '  class Database  (L3-L3)',
      '  method connect  (L4-L8)',
      '  method query  (L9-L16)',
    ].join('\n')
  );
});

test('outlineFile(migrate.py): non-JS language ("def" kind) is rendered with the same format', () => {
  const out = outlineFile(fileRecord('scripts/migrate.py'));

  assert.equal(out, ['scripts/migrate.py', '  def migrate  (L4-L9)'].join('\n'));
});

test('outlineFile(README.md): a file with zero symbols renders as just its bare path, no trailing lines', () => {
  const out = outlineFile(fileRecord('README.md'));

  assert.equal(out, 'README.md');
  assert.ok(!out.includes('\n'), 'a symbol-less file must produce a single line with no trailing newline');
});

test('outlineFile: symbol order is preserved exactly as given, not re-sorted by line number', () => {
  // Hand-built record (not from buildIndex) with symbols deliberately out of
  // line order, to prove outlineFile is a straight pass-through formatter
  // rather than one that imposes its own ordering.
  const record = {
    path: 'fake/mod.ts',
    symbols: [
      { name: 'z', kind: 'function', line: 40, endLine: 45 },
      { name: 'a', kind: 'type', line: 1, endLine: 2 },
    ],
  };

  assert.equal(
    outlineFile(record),
    ['fake/mod.ts', '  function z  (L40-L45)', '  type a  (L1-L2)'].join('\n')
  );
});

test('outlineFile: a fileRecord with no `symbols` property at all does not throw and yields the bare path', () => {
  // Per the documented `fileRecord.symbols || []` fallback.
  const record = { path: 'fake/empty.js' };
  assert.equal(outlineFile(record), 'fake/empty.js');
});

// ---------------------------------------------------------------------------
// outlineRepo
// ---------------------------------------------------------------------------

test('outlineRepo(index): full directory-grouped tree — dirs before files, ascending sort, nested subdir indentation', () => {
  const out = outlineRepo(index);

  // Exact match against the real fixture tree: at the root, directories
  // ("scripts/", "src/") are listed before files (".gitignore", "README.md"),
  // each group sorted ascending by plain string comparison. Inside src/, the
  // "api/" subdirectory is listed before its sibling files (auth.js, db.js,
  // util.js), and routes.js is indented one level deeper than auth.js/db.js/
  // util.js. Every file with symbols gets a parenthesized "kind name, ..."
  // summary; ignored/secret.txt and assets/logo.bin never appear anywhere
  // (they were excluded from the index by walkRepo, per SPEC's fixture
  // guarantees) and neither do the now-empty ignored/ or assets/ directories.
  assert.equal(
    out,
    [
      'scripts/',
      '  migrate.py (def migrate)',
      'src/',
      '  api/',
      '    routes.js (function registerRoutes, const db, const result)',
      '  auth.js (function login, function logout, const TOKEN_TTL)',
      '  db.js (class Database, method connect, method query)',
      '  util.js (function hash, const h, function slugify)',
      '.gitignore',
      'README.md',
    ].join('\n')
  );
});

test('outlineRepo(index): output does not depend on the order of index.files (internal sort is deterministic)', () => {
  // Feed the same files in reverse order; the rendered tree must be
  // byte-identical, per outlineRepo's documented determinism guarantee.
  const shuffled = { ...index, files: [...index.files].reverse() };
  assert.equal(outlineRepo(shuffled), outlineRepo(index));
});

test('outlineRepo(index, {dir}): restricts to a subtree while still showing the dir\'s own path prefix', () => {
  const out = outlineRepo(index, { dir: 'src' });

  assert.equal(
    out,
    [
      'src/',
      '  api/',
      '    routes.js (function registerRoutes, const db, const result)',
      '  auth.js (function login, function logout, const TOKEN_TTL)',
      '  db.js (class Database, method connect, method query)',
      '  util.js (function hash, const h, function slugify)',
    ].join('\n')
  );

  // Files outside the requested subtree must not leak in.
  assert.ok(!out.includes('migrate.py'));
  assert.ok(!out.includes('README.md'));
});

test('outlineRepo(index, {dir}): a trailing slash on opts.dir is normalized the same as no trailing slash', () => {
  assert.equal(outlineRepo(index, { dir: 'src/' }), outlineRepo(index, { dir: 'src' }));
});

test('outlineRepo(index, {dir}): an exact file path (not just a directory prefix) restricts to that single file', () => {
  const out = outlineRepo(index, { dir: 'src/auth.js' });

  assert.equal(
    out,
    ['src/', '  auth.js (function login, function logout, const TOKEN_TTL)'].join('\n')
  );
});

test('outlineRepo(index, {dir}): a subtree matching nothing returns a one-line placeholder, not an empty string', () => {
  const out = outlineRepo(index, { dir: 'nope' });

  assert.equal(out, '(no files under nope)');
  assert.notEqual(out, '', 'must not silently return an empty string for an unmatched subtree');
});
