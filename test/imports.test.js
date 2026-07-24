// test/imports.test.js
//
// Tests for src/imports.js (extractImports), grounded in:
//  - SPEC.md "Fixture repo (fixtures/sample)" guarantees (e.g. "routes.js
//    imports include '../auth.js' and '../db.js'").
//  - SPEC.md per-file contract for src/imports.js and src/lang.js
//    (LANG_RULES[lang].importPatterns, capture group 1 = raw specifier).
//  - Clarification #3 ("LANG_RULES total coverage").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { extractImports } from '../src/imports.js';
import { LANG_RULES, detectLang } from '../src/lang.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, '..', 'fixtures', 'sample');

async function readFixture(relPath) {
  return readFile(path.join(FIXTURE_ROOT, relPath), 'utf8');
}

// ---------------------------------------------------------------------------
// Fixture-grounded assertions (SPEC.md "Fixture repo" guarantees, verbatim)
// ---------------------------------------------------------------------------

test('routes.js imports resolve to exactly ../auth.js and ../db.js, in source order', async () => {
  const rel = 'src/api/routes.js';
  const text = await readFixture(rel);
  const specifiers = extractImports(text, detectLang(rel));
  // SPEC.md line 99: "routes.js imports include ../auth.js and ../db.js".
  // routes.js has a top-of-file header comment before either import line, so
  // this also exercises extraction of import statements that are not on the
  // file's very first line.
  assert.deepEqual(specifiers, ['../auth.js', '../db.js']);
});

test('migrate.py imports include os', async () => {
  const rel = 'scripts/migrate.py';
  const text = await readFixture(rel);
  const specifiers = extractImports(text, detectLang(rel));
  // SPEC.md line 101: "migrate.py symbols include migrate; imports include os".
  assert.deepEqual(specifiers, ['os']);
});

test('auth.js, db.js, and util.js have zero import statements', async () => {
  for (const rel of ['src/auth.js', 'src/db.js', 'src/util.js']) {
    const text = await readFixture(rel);
    const specifiers = extractImports(text, detectLang(rel));
    assert.deepEqual(specifiers, [], `${rel} should have zero import specifiers`);
  }
});

// ---------------------------------------------------------------------------
// Hermetic JS/TS pattern coverage.
// extractImports takes (text, lang) directly -- no disk repo is needed for
// these; the strings below stand in for file contents.
// ---------------------------------------------------------------------------

test('js: every import form is captured, ordered by position in the source (not pattern-array order)', () => {
  // Deliberately arranged so the pattern that appears FIRST in
  // LANG_RULES.js.importPatterns ("import ... from") matches the LAST line,
  // and the pattern that appears LAST in the array (dynamic import()) matches
  // the FIRST line. If extractImports grouped results by which pattern
  // matched instead of sorting by match index, this would come back in the
  // wrong order.
  const text = [
    "const mod = import('dyn-one');",
    "require('req-two');",
    "export { x } from 'reexport-three';",
    "import 'side-effect-four';",
    "import five from 'from-five';",
  ].join('\n');

  const specifiers = extractImports(text, 'js');
  assert.deepEqual(specifiers, [
    'dyn-one',
    'req-two',
    'reexport-three',
    'side-effect-four',
    'from-five',
  ]);
});

test('js: named, default, and namespace import forms each yield their module specifier', () => {
  const text = [
    "import { login, logout } from '../auth.js';",
    'import Database from "../db.js";',
    "import * as utils from '../util.js';",
  ].join('\n');

  const specifiers = extractImports(text, 'js');
  assert.deepEqual(specifiers, ['../auth.js', '../db.js', '../util.js']);
});

test('ts reuses the js import patterns', () => {
  const text = [
    "import type { Foo } from './types.js';",
    "import { bar } from './bar.js';",
  ].join('\n');

  assert.deepEqual(extractImports(text, 'ts'), ['./types.js', './bar.js']);
});

test('jsx/tsx alias to the same import behavior as js/ts', () => {
  const text = [
    "import React from 'react';",
    "import { useState } from 'react-dom';",
  ].join('\n');

  assert.deepEqual(extractImports(text, 'jsx'), ['react', 'react-dom']);
  assert.deepEqual(extractImports(text, 'tsx'), ['react', 'react-dom']);
});

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

test('py: "import x", "from x import y", and "from . import y" are all captured', () => {
  const text = [
    'import os',
    'from collections import OrderedDict',
    'from . import helpers',
    'from .models import User',
  ].join('\n');

  const specifiers = extractImports(text, 'py');
  assert.deepEqual(specifiers, ['os', 'collections', '.', '.models']);
});

// ---------------------------------------------------------------------------
// Generic fallback (go/rust/java/rb/php/c/cpp/cs/text share GENERIC_RULES)
// ---------------------------------------------------------------------------

test('generic fallback extracts go, java, rust, and C import/use/include specifiers', () => {
  assert.equal(LANG_RULES.go, LANG_RULES.text, 'go should share the one generic rules object');
  assert.equal(LANG_RULES.java, LANG_RULES.text, 'java should share the one generic rules object');

  assert.deepEqual(extractImports('import "fmt"\n', 'go'), ['fmt']);
  assert.deepEqual(extractImports('import java.util.List;\n', 'java'), ['java.util.List']);
  assert.deepEqual(extractImports('use std::io;\n', 'rust'), ['std::io']);
  assert.deepEqual(extractImports('#include <stdio.h>\n', 'c'), ['stdio.h']);
});

test('generic fallback does not duplicate one statement matched by multiple rules', () => {
  assert.deepEqual(extractImports('use Foo;\n', 'rust'), ['Foo']);
  assert.deepEqual(extractImports('use Foo;\nuse Foo;\n', 'php'), ['Foo', 'Foo']);
  assert.deepEqual(extractImports('use Foo\\Bar;\n', 'php'), ['Foo\\Bar']);
});

test('LANG_RULES has an importPatterns array for every lang detectLang can return', () => {
  // Clarification #3: LANG_RULES must have total coverage, and imports.js is
  // allowed to index LANG_RULES[lang] directly with no `||` fallback.
  const langs = ['js', 'ts', 'jsx', 'tsx', 'py', 'go', 'rust', 'java', 'rb', 'php', 'c', 'cpp', 'cs', 'text'];
  for (const lang of langs) {
    assert.ok(
      Array.isArray(LANG_RULES[lang]?.importPatterns),
      `LANG_RULES.${lang}.importPatterns must be an array`
    );
    // Must not throw, and must yield no specifiers, for text with no imports.
    assert.deepEqual(extractImports('hello world, nothing to see here', lang), []);
  }
});
