// src/rank.js
//
// Combines lexical BM25 scoring with a symbol-name boost and an import-graph
// proximity boost to rank a codebase's indexed chunks against a free-text
// task description. Pure: everything needed comes from the already-built
// `index` object (per SPEC.md schema) — no disk access here.

import { tokenize } from './tokenize.js';
import { scoreBM25 } from './bm25.js';
import { splitIdentifier } from './util.js';
import { neighbors } from './graph.js';

const SYMBOL_BOOST_PER_MATCH = 1.5;
const SYMBOL_BOOST_CAP = 3.0;
const GRAPH_BOOST = 0.5;
const GRAPH_SEED_COUNT = 10;
const DEFAULT_TOP = 20;

// Source-priority demotion. On a real repo, test/fixture/snapshot/example
// files repeat query terms far more than the actual implementation, so raw
// BM25 buries real source under noise. As a final re-rank we multiply the
// score of files whose path looks generated/non-source by TEST_DEMOTION, so
// the implementation outranks the files that merely mention it. Opt out with
// opts.includeTests (CLI: --tests) to search everything at full weight.
const TEST_DEMOTION = 0.2;
// A path segment that marks a non-source tree.
const DIR_DEMOTE_RE = /(^|\/)(__tests__|__mocks__|__snapshots__|__fixtures__|tests?|fixtures?|e2e|examples?|docs|node_modules|benchmarks?)(\/)/i;
// A filename suffix that marks a test/snapshot/fixture file.
const FILE_DEMOTE_RE = /\.(test|spec|stories)\.[cm]?[jt]sx?$|\.snap$|\.expect\.md$/i;
// A whole word in the basename that marks non-source (word-bounded so
// "attestation.js" / "constitution.ts" are NOT demoted).
const BASENAME_WORD_RE = /(^|[^a-z0-9])(tests?|specs?|fixtures?|mocks?|benchmarks?|examples?|stories|e2e)([^a-z0-9]|$)/i;

/** Ranking multiplier: 1 for real source, TEST_DEMOTION for test/fixture/etc. */
export function sourcePriority(file) {
  const base = file.slice(file.lastIndexOf('/') + 1);
  if (DIR_DEMOTE_RE.test(file) || FILE_DEMOTE_RE.test(file) || BASENAME_WORD_RE.test(base)) {
    return TEST_DEMOTION;
  }
  return 1;
}

/**
 * Rank the chunks in `index` against `task`.
 *
 * Pipeline (see SPEC.md "Ranking algorithm"):
 *   1. tokenize the task.
 *   2. score every chunk with BM25 (chunks with no positive-idf overlap never
 *      appear in the result — boosts below can only affect chunks already
 *      scored here, never introduce new ones).
 *   3. symbol boost: +1.5 per distinct query subtoken that matches one of the
 *      chunk's symbol's subtokens (splitIdentifier), capped at +3.0/chunk.
 *   4. graph proximity boost: seed from the top 10 chunks (by post-symbol
 *      score, using the same deterministic ordering as the final sort);
 *      every already-scored chunk whose file is a 1-hop import neighbor
 *      (either direction) of a seed chunk's file gets +0.5, applied once
 *      even if multiple seeds point at it.
 *   5. sort desc by final score, tie-break (file asc, startLine asc).
 *   6. return the top `opts.top` (default 20) as plain result objects.
 *
 * @param {object} index - full grasp index (per SPEC.md schema)
 * @param {string} task - free-text task/query string
 * @param {{ top?: number }} [opts]
 * @returns {Array<{ file: string, startLine: number, endLine: number, symbol: string|null, score: number, reasons: string[] }>}
 */
export function rank(index, task, opts = {}) {
  const top = opts.top ?? DEFAULT_TOP;
  if (!Number.isInteger(top) || top < 0) {
    throw new Error('top must be a non-negative integer');
  }
  const chunkMeta = index.bm25.chunkMeta;

  const queryTokens = tokenize(task);
  const scores = scoreBM25(index.bm25, queryTokens);

  // reasons accumulates a short human/agent-readable trail per chunkId, in
  // the order boosts are applied: bm25 first, then symbol, then graph.
  const reasons = new Map();
  for (const [id, score] of scores) {
    reasons.set(id, [`bm25:${score.toFixed(1)}`]);
  }

  // --- Symbol boost ------------------------------------------------------
  for (const id of scores.keys()) {
    const symbol = chunkMeta[id].symbol;
    if (!symbol) continue;

    const symbolSubtokens = new Set(splitIdentifier(symbol));
    // Tokenization deliberately preserves duplicates for term frequency, and
    // clarification #4 awards +1.5 for each matching query subtoken (up to the
    // per-chunk cap). Do not collapse repeated query tokens here.
    const matched = queryTokens.filter((qt) => symbolSubtokens.has(qt));
    if (matched.length === 0) continue;

    const boost = Math.min(SYMBOL_BOOST_PER_MATCH * matched.length, SYMBOL_BOOST_CAP);
    scores.set(id, scores.get(id) + boost);
    for (const m of matched) reasons.get(id).push(`symbol:${m}`);
  }

  // --- Graph proximity boost ----------------------------------------------
  // Seed from the top 10 chunks using the same comparator as the final sort
  // (post-symbol-boost score, deterministic tie-break) so seed selection
  // itself is stable.
  const seedIds = [...scores.keys()]
    .sort((a, b) => compareByScore(scores, chunkMeta, a, b))
    .slice(0, GRAPH_SEED_COUNT);

  // neighborFile -> the seed's file that first reached it (for the reason
  // string). Union of imports+importedBy at depth 1, across all seeds.
  const neighborSource = new Map();
  for (const seedId of seedIds) {
    const seedFile = chunkMeta[seedId].file;
    const nb = neighbors(index.graph, seedFile, 1);
    for (const nfile of [...nb.imports, ...nb.importedBy]) {
      if (!neighborSource.has(nfile)) neighborSource.set(nfile, seedFile);
    }
  }

  if (neighborSource.size > 0) {
    for (const id of scores.keys()) {
      const source = neighborSource.get(chunkMeta[id].file);
      if (source === undefined) continue;
      // Applied once total per chunk, regardless of how many seeds' neighbor
      // sets it falls into.
      scores.set(id, scores.get(id) + GRAPH_BOOST);
      reasons.get(id).push(`graph:${basename(source)}`);
    }
  }

  // --- Source-priority demotion (final re-rank) ---------------------------
  // Applied after boosts so seed selection above still uses raw relevance;
  // real-source files (multiplier 1) keep their exact score, and only
  // test/fixture/generated files are pushed down.
  if (!opts.includeTests) {
    for (const id of scores.keys()) {
      const p = sourcePriority(chunkMeta[id].file);
      if (p !== 1) {
        scores.set(id, scores.get(id) * p);
        reasons.get(id).push(`demoted:${p}`);
      }
    }
  }

  // --- Final sort + shape --------------------------------------------------
  const ids = [...scores.keys()].sort((a, b) => compareByScore(scores, chunkMeta, a, b));

  return ids.slice(0, top).map((id) => {
    const meta = chunkMeta[id];
    return {
      file: meta.file,
      startLine: meta.startLine,
      endLine: meta.endLine,
      symbol: meta.symbol ?? null,
      score: scores.get(id),
      reasons: reasons.get(id),
    };
  });
}

/**
 * Deterministic comparator: score desc, then file asc, then startLine asc.
 * Shared by seed selection and the final sort so both orderings agree.
 */
function compareByScore(scores, chunkMeta, a, b) {
  const diff = scores.get(b) - scores.get(a);
  if (diff !== 0) return diff;
  const fa = chunkMeta[a].file;
  const fb = chunkMeta[b].file;
  if (fa !== fb) return fa < fb ? -1 : 1;
  return chunkMeta[a].startLine - chunkMeta[b].startLine;
}

/** Basename of a POSIX repo path (index paths are always POSIX). */
function basename(posixPath) {
  const idx = posixPath.lastIndexOf('/');
  return idx === -1 ? posixPath : posixPath.slice(idx + 1);
}
