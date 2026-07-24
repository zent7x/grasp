// src/bm25.js
//
// Classic Okapi BM25 index construction and scoring over pre-tokenized
// documents (chunks). This module is pure: it never touches disk and knows
// nothing about files, chunks, or the wider index schema beyond the plain
// `{ id, tokens }` doc shape it's given.

/**
 * Build a BM25 index from a list of documents.
 *
 * @param {Array<{ id: string, tokens: string[] }>} docs
 * @returns {{
 *   N: number,
 *   avgdl: number,
 *   df: Record<string, number>,
 *   postings: Record<string, Array<[string, number]>>,
 *   docLen: Record<string, number>
 * }}
 */
export function buildBM25(docs) {
  // Build with Maps so valid term/document ids such as "constructor",
  // "toString", and "__proto__" cannot collide with Object.prototype.
  // Object.fromEntries still gives callers the plain objects required by the
  // persisted index schema, while defining those names as own data properties.
  const df = new Map();
  const postings = new Map();
  const docLen = new Map();

  const N = docs.length;
  let totalLen = 0;

  for (const { id, tokens } of docs) {
    const len = tokens.length;
    docLen.set(id, len);
    totalLen += len;

    // Per-doc term frequency (tokens array carries duplicates on purpose —
    // see tokenize.js — so this collapses them into counts).
    const tf = new Map();
    for (const tok of tokens) {
      tf.set(tok, (tf.get(tok) || 0) + 1);
    }

    for (const [term, count] of tf) {
      if (!postings.has(term)) postings.set(term, []);
      postings.get(term).push([id, count]);
      df.set(term, (df.get(term) || 0) + 1);
    }
  }

  const avgdl = N > 0 ? totalLen / N : 0;

  return {
    N,
    avgdl,
    df: Object.fromEntries(df),
    postings: Object.fromEntries(postings),
    docLen: Object.fromEntries(docLen),
  };
}

/**
 * Score every indexed document against `queryTokens` using classic BM25:
 *
 *   idf(t)      = ln(1 + (N - df(t) + 0.5) / (df(t) + 0.5))   — only kept if > 0
 *   score(D, t) = idf(t) * (tf(t,D) * (k1+1)) / (tf(t,D) + k1 * (1 - b + b * |D|/avgdl))
 *
 * Repeated tokens in `queryTokens` (duplicates from `tokenize`) scale their
 * term's contribution linearly, matching the standard sum-over-query-terms
 * formulation. Documents that share no positive-idf term with the query
 * never get a map entry (no zero/undefined scores are emitted).
 *
 * @param {{ N: number, avgdl: number, df: Record<string, number>, postings: Record<string, Array<[string, number]>>, docLen: Record<string, number> }} bm25
 * @param {string[]} queryTokens
 * @param {{ k1?: number, b?: number }} [opts]
 * @returns {Map<string, number>}
 */
export function scoreBM25(bm25, queryTokens, opts = {}) {
  const k1 = opts.k1 ?? 1.5;
  const b = opts.b ?? 0.75;
  const { N, avgdl, df, postings, docLen } = bm25;

  const scores = new Map();
  if (!Array.isArray(queryTokens) || queryTokens.length === 0) return scores;

  // Collapse duplicate query tokens into counts so we compute idf/postings
  // lookups once per unique term, then scale the contribution by count.
  const qtf = new Map();
  for (const term of queryTokens) {
    qtf.set(term, (qtf.get(term) || 0) + 1);
  }

  for (const [term, qCount] of qtf) {
    const termDf = Object.hasOwn(df, term) ? df[term] : undefined;
    if (!termDf) continue; // term never seen in the corpus

    const idf = Math.log(1 + (N - termDf + 0.5) / (termDf + 0.5));
    if (idf <= 0) continue; // only positive idf contributes

    const termPostings = Object.hasOwn(postings, term) ? postings[term] : undefined;
    if (!termPostings) continue;

    for (const [id, tf] of termPostings) {
      const dl = Object.hasOwn(docLen, id) ? docLen[id] : 0;
      const denom = tf + k1 * (1 - b + b * (dl / (avgdl || 1)));
      const contribution = idf * ((tf * (k1 + 1)) / denom) * qCount;

      scores.set(id, (scores.get(id) || 0) + contribution);
    }
  }

  return scores;
}
