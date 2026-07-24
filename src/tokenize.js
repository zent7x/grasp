// src/tokenize.js
// Tokenizes arbitrary text (source code or task strings) into a flat, duplicate-preserving
// array of lowercase tokens used by both the BM25 indexer and the ranker's query path.
import { splitIdentifier } from './util.js';

/**
 * Split `text` on runs of non-alphanumeric characters to get raw identifiers, then expand
 * each raw identifier via `splitIdentifier` (camelCase/snake_case/kebab-case/digit-boundary
 * splitting; the returned array already includes the whole lowercased token, so the raw
 * token itself is NOT additionally emitted — see SPEC.md clarification #2). Subtokens shorter
 * than 2 characters are dropped. Duplicates arising from different raw tokens are preserved
 * (term-frequency signal for BM25).
 *
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  if (typeof text !== 'string' || text.length === 0) return [];

  const rawTokens = text.match(/[A-Za-z0-9]+/g);
  if (!rawTokens) return [];

  const tokens = [];
  for (const raw of rawTokens) {
    const subtokens = splitIdentifier(raw);
    for (const sub of subtokens) {
      if (sub.length >= 2) tokens.push(sub);
    }
  }
  return tokens;
}
