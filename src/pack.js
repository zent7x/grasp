// src/pack.js
//
// Builds a budgeted, markdown-formatted "context pack" for a task: rank the
// index, greedily pull in ranked chunks (re-reading their source lines from
// disk) until the token budget would be exceeded, and render the result as a
// short header followed by one section per file with fenced code blocks.
//
// This module does no ranking math of its own (see rank.js) and no budgeting
// math of its own (see tokens.js) — it composes those with disk reads.

import { rank } from './rank.js';
import { safeResolve, readLines } from './util.js';
import { estimateTokens, fitToBudget } from './tokens.js';
import { loadConfig } from './config.js';

/**
 * @typedef {{ file: string, startLine: number, endLine: number, symbol: string|null, score: number, reasons: string[] }} RankResult
 * @typedef {{ file: string, startLine: number, endLine: number, tokens: number }} IncludedChunk
 */

/**
 * Assemble a budgeted context pack for `task` against `index`.
 *
 * Steps (SPEC.md src/pack.js + clarifications #8, #9):
 *  1. `results = rank(index, task, opts)`.
 *  2. Dedupe overlapping ranges against higher-ranked chunks from the same
 *     file. Chunks are non-overlapping by construction, so this is normally
 *     a no-op; a stale/synthetic index may require trimming a later range to
 *     only its still-uncovered segment(s).
 *  3. Re-read each surviving chunk's code via `util.readLines` and measure
 *     it with `tokens.estimateTokens` (un-numbered, raw code only — markdown
 *     scaffolding is never counted).
 *  4. Greedily keep the ranked prefix that fits `opts.budget` tokens via
 *     `tokens.fitToBudget` (stops at the first chunk that would overflow;
 *     that chunk and everything after it is dropped).
 *  5. Render markdown: a short header, then per file one or more fenced
 *     code blocks titled `// path:Lstart-Lend` (not line-numbered), in
 *     ranked order within the file. A file with some chunks dropped gets a
 *     one-line note appended after its block(s); a file with ALL of its
 *     chunks dropped is instead listed in a trailing "Trimmed" section.
 *
 * @param {object} index - a built grasp index (see SPEC.md Index JSON schema)
 * @param {string} root - absolute repo root (chunks are re-read from here)
 * @param {string} task - free-text task description used to rank the index
 * @param {{ budget?: number, top?: number }} [opts]
 * @returns {Promise<{ text: string, included: IncludedChunk[], trimmed: string[], tokens: number }>}
 */
export async function pack(index, root, task, opts = {}) {
  const budget = opts.budget === undefined ? (await loadConfig(root)).budget : opts.budget;
  if (!Number.isFinite(budget) || budget < 0) {
    throw new Error('budget must be a non-negative finite number');
  }

  /** @type {RankResult[]} */
  const results = rank(index, task, opts);

  const langByPath = new Map();
  for (const f of index?.files || []) {
    langByPath.set(f.path, f.lang);
  }

  // Dedupe: subtract every previously-seen (higher-ranked) range for this
  // file. This removes fully-contained duplicates and trims partial overlaps
  // without throwing away the later chunk's still-unique lines.
  const coverage = new Map(); // file -> [[startLine, endLine], ...]
  const deduped = [];
  for (const r of results) {
    const ranges = coverage.get(r.file) || [];
    for (const [startLine, endLine] of subtractCovered(r.startLine, r.endLine, ranges)) {
      deduped.push({ ...r, startLine, endLine });
    }
    ranges.push([r.startLine, r.endLine]);
    coverage.set(r.file, ranges);
  }

  // Re-read candidates in ranked order only until the first overflow. Prefix
  // budgeting means every later candidate is necessarily dropped, so reading
  // those files would add work and could make an otherwise-valid pack fail
  // because an irrelevant, already-trimmed file went stale after indexing.
  const candidates = [];
  let unreadDropped = [];
  let provisionalUsed = 0;
  for (let i = 0; i < deduped.length; i++) {
    const r = deduped[i];
    const absPath = safeResolve(root, r.file);
    const code = await readLines(absPath, r.startLine, r.endLine);
    const candidate = {
      file: r.file,
      startLine: r.startLine,
      endLine: r.endLine,
      symbol: r.symbol,
      code,
      tokens: estimateTokens(code),
    };
    candidates.push(candidate);

    if (provisionalUsed + candidate.tokens > budget) {
      unreadDropped = deduped.slice(i + 1).map((item) => ({ file: item.file }));
      break;
    }
    provisionalUsed += candidate.tokens;
  }

  const fitted = fitToBudget(candidates, budget, (c) => c.tokens);
  const included = fitted.included;
  const dropped = [...fitted.dropped, ...unreadDropped];
  const used = fitted.used;

  // Group included chunks by file, preserving first-seen (ranked) order
  // across files, and by startLine within a file.
  const fileOrder = [];
  const byFile = new Map();
  for (const c of included) {
    if (!byFile.has(c.file)) {
      byFile.set(c.file, []);
      fileOrder.push(c.file);
    }
    byFile.get(c.file).push(c);
  }
  for (const chunks of byFile.values()) {
    chunks.sort((a, b) => a.startLine - b.startLine);
  }

  const includedFiles = new Set(fileOrder);
  const droppedFileOrder = [];
  const droppedFileSet = new Set();
  for (const c of dropped) {
    if (!droppedFileSet.has(c.file)) {
      droppedFileSet.add(c.file);
      droppedFileOrder.push(c.file);
    }
  }
  const partiallyDroppedFiles = new Set([...droppedFileSet].filter((f) => includedFiles.has(f)));
  const fullyDroppedFiles = droppedFileOrder.filter((f) => !includedFiles.has(f));

  const lines = [];
  lines.push(`# grasp pack: ${task}`);
  lines.push('');
  lines.push(
    included.length > 0
      ? `_${included.length} chunk(s) from ${fileOrder.length} file(s), ~${used} tokens (budget ${budget})_`
      : `_no chunks fit within budget ${budget}_`
  );
  lines.push('');

  for (const file of fileOrder) {
    lines.push(`## ${file}`);
    lines.push('');
    const lang = langByPath.get(file) || 'text';
    for (const c of byFile.get(file)) {
      lines.push('```' + lang);
      lines.push(`// ${file}:${c.startLine}-${c.endLine}`);
      lines.push(c.code);
      lines.push('```');
    }
    if (partiallyDroppedFiles.has(file)) {
      lines.push(`_(more of ${file} omitted — budget exceeded; see \`grasp outline ${file}\`)_`);
    }
    lines.push('');
  }

  if (fullyDroppedFiles.length > 0) {
    lines.push('## Trimmed (not included)');
    lines.push('');
    for (const file of fullyDroppedFiles) {
      lines.push(`- ${file} — see \`grasp outline ${file}\``);
    }
    lines.push('');
  }

  const text = lines.join('\n').replace(/\n{3,}$/, '\n\n').replace(/\n+$/, '\n');

  return {
    text,
    included: included.map((c) => ({ file: c.file, startLine: c.startLine, endLine: c.endLine, tokens: c.tokens })),
    trimmed: droppedFileOrder,
    tokens: used,
  };
}

/** Return the portions of [start,end] not covered by any prior range. */
function subtractCovered(start, end, covered) {
  let remaining = [[start, end]];

  for (const [coveredStart, coveredEnd] of covered) {
    const next = [];
    for (const [segmentStart, segmentEnd] of remaining) {
      if (coveredEnd < segmentStart || coveredStart > segmentEnd) {
        next.push([segmentStart, segmentEnd]);
        continue;
      }
      if (segmentStart < coveredStart) {
        next.push([segmentStart, coveredStart - 1]);
      }
      if (segmentEnd > coveredEnd) {
        next.push([coveredEnd + 1, segmentEnd]);
      }
    }
    remaining = next;
    if (remaining.length === 0) break;
  }

  return remaining;
}
