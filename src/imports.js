// src/imports.js
// Extracts raw import specifiers (as written in source) for a given language,
// using the importPatterns provided by src/lang.js's LANG_RULES table.

import { LANG_RULES } from './lang.js';

/**
 * Extract raw import specifiers from file text.
 * @param {string} text - full file contents
 * @param {string} lang - language key into LANG_RULES (e.g. "js", "py")
 * @returns {string[]} raw specifiers as written, e.g. "../auth.js", "os", "react"
 *   in the order they appear in the source.
 */
export function extractImports(text, lang) {
  const { importPatterns } = LANG_RULES[lang];
  const found = [];
  const seenMatches = new Set();

  for (const pattern of importPatterns) {
    // Each rule is applied to the full file. `g` lets matchAll find every
    // occurrence, while `m` makes the line-anchored rules (`^\\s*import`,
    // `^\\s*from`, etc.) match every source line rather than only byte 0.
    const flags = new Set(pattern.flags);
    flags.add('g');
    flags.add('m');
    const re = new RegExp(pattern.source, [...flags].join(''));

    for (const match of text.matchAll(re)) {
      // Capture group 1 is the specifier, per the LANG_RULES contract.
      if (match[1] !== undefined) {
        // Generic rule sets intentionally cover several languages, so two
        // patterns may recognize the same statement (for example a simple
        // Rust/PHP `use Foo;`). Keep repeated statements at different source
        // positions, but never duplicate one lexical match.
        const key = `${match.index}\0${match[1]}`;
        if (!seenMatches.has(key)) {
          seenMatches.add(key);
          found.push({ index: match.index, specifier: match[1] });
        }
      }
    }
  }

  // Multiple patterns can match the same file (e.g. `import ... from 'x'` and
  // `require('x')` for js/ts); sort by source position so the result reflects
  // the order specifiers appear in the file, regardless of pattern order.
  found.sort((a, b) => a.index - b.index);

  // Generic languages share one rule table, so multiple patterns can match
  // the same statement. Group matches by source position and keep the longest
  // capture: for PHP `use Foo\Bar;`, for example, the Rust rule sees only
  // `Foo` while the PHP rule captures the full raw specifier `Foo\Bar`.
  const byOccurrence = new Map();
  for (const item of found) {
    const existing = byOccurrence.get(item.index);
    if (!existing || item.specifier.length > existing.length) {
      byOccurrence.set(item.index, item.specifier);
    }
  }
  return [...byOccurrence.values()];
}
