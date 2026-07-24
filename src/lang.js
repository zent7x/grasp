// src/lang.js
//
// Language detection + per-language rule tables (comment marker, symbol
// extraction patterns, import extraction patterns) used by symbols.js and
// imports.js. Every symbol pattern's capture group 1 MUST be the symbol name.
//
// No sibling imports: this module is pure data + a small pure function.

/**
 * Detect a language id from a repo-relative path (POSIX or OS-native
 * separators both accepted). Returns one of:
 *   js | ts | jsx | tsx | py | go | rust | java | rb | php | c | cpp | cs | text
 *
 * @param {string} relPath
 * @returns {string}
 */
export function detectLang(relPath) {
  const normalized = String(relPath).replace(/\\/g, '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase();
  const dot = base.lastIndexOf('.');
  const ext = dot >= 0 ? base.slice(dot) : '';

  switch (ext) {
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'js';
    case '.jsx':
      return 'jsx';
    case '.ts':
    case '.mts':
    case '.cts':
      return 'ts';
    case '.tsx':
      return 'tsx';
    case '.py':
    case '.pyw':
      return 'py';
    case '.go':
      return 'go';
    case '.rs':
      return 'rust';
    case '.java':
      return 'java';
    case '.rb':
      return 'rb';
    case '.php':
      return 'php';
    case '.c':
    case '.h':
      return 'c';
    case '.cpp':
    case '.cc':
    case '.cxx':
    case '.hpp':
    case '.hh':
    case '.hxx':
      return 'cpp';
    case '.cs':
      return 'cs';
    default:
      return 'text';
  }
}

const IDENT = '[A-Za-z_$][\\w$]*';

// ---------------------------------------------------------------------------
// JS / TS symbol patterns (kind capture group 1 = symbol name)
// ---------------------------------------------------------------------------

const jsSymbolPatterns = [
  // export default function foo(...) / async function* foo(...)
  {
    kind: 'function',
    re: new RegExp(
      `^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s+(${IDENT})\\s*\\(`
    ),
  },
  // export class Foo extends Bar {  /  export default class Foo {
  {
    kind: 'class',
    re: new RegExp(
      `^\\s*(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+(${IDENT})`
    ),
  },
  // const foo = (a, b) => { ... } / const foo = x => x /
  // export const foo = async (a) => { ... }
  {
    kind: 'function',
    re: new RegExp(
      `^\\s*(?:export\\s+)?(?:const|let|var)\\s+(${IDENT})\\s*(?::[^=]+)?=\\s*(?:async\\s*)?(?:\\([^)]*\\)|${IDENT})\\s*(?::[^=]+)?=>`
    ),
  },
  // export const TOKEN_TTL = 3600;  (plain value, not an arrow function)
  {
    kind: 'const',
    re: new RegExp(
      `^\\s*(?:export\\s+)?(?:const|let|var)\\s+(${IDENT})\\s*(?::[^=]+)?=(?!.*=>)`
    ),
  },
  // class-body method shorthand: `  connect() {`, `  static async run(x) {`
  {
    kind: 'method',
    re: new RegExp(
      `^\\s+(?:static\\s+)?(?:public\\s+|private\\s+|protected\\s+)?(?:async\\s+)?(?:get\\s+|set\\s+)?(?!if\\b|for\\b|while\\b|switch\\b|catch\\b|function\\b|return\\b)(${IDENT})\\s*\\(([^()]*)\\)\\s*(?::[^\\{]+)?\\{`
    ),
  },
  // export default identifier;
  {
    kind: 'other',
    re: new RegExp(`^\\s*export\\s+default\\s+(${IDENT})\\s*;?\\s*$`),
  },
  // module.exports.foo = ... / exports.foo = ...
  {
    kind: 'other',
    re: new RegExp(`^\\s*(?:module\\.)?exports\\.(${IDENT})\\s*=`),
  },
];

const tsSymbolPatterns = [
  ...jsSymbolPatterns,
  // export interface Foo {
  {
    kind: 'type',
    re: new RegExp(`^\\s*(?:export\\s+)?interface\\s+(${IDENT})`),
  },
  // export type Foo = ...
  {
    kind: 'type',
    re: new RegExp(`^\\s*(?:export\\s+)?type\\s+(${IDENT})\\s*(?:<[^=]*>)?\\s*=`),
  },
];

// ---------------------------------------------------------------------------
// JS / TS import patterns (capture group 1 = raw specifier as written)
// ---------------------------------------------------------------------------

const jsImportPatterns = [
  // import ... from 'x'   (named / default / namespace)
  /^\s*import\s+[^'"]*from\s+['"]([^'"]+)['"]/,
  // import 'x'  (side-effect only)
  /^\s*import\s+['"]([^'"]+)['"]/,
  // export ... from 'x'  (re-export)
  /^\s*export\s+[^'"]*from\s+['"]([^'"]+)['"]/,
  // require('x')
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/,
  // import('x')  (dynamic import)
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/,
];

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

const pySymbolPatterns = [
  { kind: 'def', re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/ },
  { kind: 'class', re: /^\s*class\s+([A-Za-z_]\w*)\s*[:(]/ },
];

const pyImportPatterns = [
  // from x import y   /  from .pkg import y  /  from . import y
  /^\s*from\s+([.\w]+)\s+import\b/,
  // import x  /  import x.y  /  import x as z
  /^\s*import\s+([A-Za-z_][\w.]*)/,
];

// ---------------------------------------------------------------------------
// Generic fallback shared by languages without bespoke rules
// ---------------------------------------------------------------------------

const genericSymbolPatterns = [
  {
    kind: 'function',
    re: /^\s*(?:pub\s+|public\s+|private\s+|protected\s+|static\s+)*(?:func|fn|def|function)\s+([A-Za-z_]\w*)\s*\(/,
  },
  {
    kind: 'class',
    re: /^\s*(?:public\s+|private\s+|protected\s+|abstract\s+|final\s+)*class\s+([A-Za-z_]\w*)/,
  },
  {
    kind: 'other',
    re: /^\s*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:interface|struct|enum|trait|module)\s+([A-Za-z_]\w*)/,
  },
];

const genericImportPatterns = [
  /^\s*import\s+"([^"]+)"/, // Go
  /^\s*import\s+([\w.]+)\s*;/, // Java
  /^\s*use\s+([\w:]+)/, // Rust
  /^\s*use\s+([\w\\]+)\s*;/, // PHP namespace use
  /^\s*require(?:_relative)?\s*['"]?([^'";\s]+)['"]?/, // Ruby
  /^\s*#include\s*[<"]([^>"]+)[>"]/, // C / C++
  /^\s*using\s+([\w.]+)\s*;/, // C#
];

const GENERIC_RULES = {
  line: /^\s*(?:\/\/|#).*/,
  symbolPatterns: genericSymbolPatterns,
  importPatterns: genericImportPatterns,
};

const JS_RULES = {
  line: /^\s*\/\/.*/,
  symbolPatterns: jsSymbolPatterns,
  importPatterns: jsImportPatterns,
};

const TS_RULES = {
  line: /^\s*\/\/.*/,
  symbolPatterns: tsSymbolPatterns,
  importPatterns: jsImportPatterns,
};

const PY_RULES = {
  line: /^\s*#.*/,
  symbolPatterns: pySymbolPatterns,
  importPatterns: pyImportPatterns,
};

/**
 * lang -> { line, symbolPatterns, importPatterns }
 * Has a key for every value detectLang() can return. jsx/tsx reuse the js/ts
 * rule objects verbatim; all other non-bespoke languages share ONE generic
 * rule object instance.
 */
export const LANG_RULES = {
  js: JS_RULES,
  jsx: JS_RULES,
  ts: TS_RULES,
  tsx: TS_RULES,
  py: PY_RULES,
  go: GENERIC_RULES,
  rust: GENERIC_RULES,
  java: GENERIC_RULES,
  rb: GENERIC_RULES,
  php: GENERIC_RULES,
  c: GENERIC_RULES,
  cpp: GENERIC_RULES,
  cs: GENERIC_RULES,
  text: GENERIC_RULES,
};
