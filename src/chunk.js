// src/chunk.js
//
// Splits a file's full text into a gapless, non-overlapping sequence of
// 1-based inclusive line-range chunks, preferring symbol boundaries (as
// produced by src/symbols.js) and falling back to fixed-size windows for
// un-symboled regions and for symbols whose own range exceeds the
// configured max chunk size. Pure function: no disk access, no imports.

const DEFAULT_CHUNK_MAX_LINES = 60;

/**
 * Split [start, end] (1-based inclusive) into consecutive windows of at most
 * `maxLines` lines each, all tagged with the same `symbolName`.
 *
 * @param {number} start
 * @param {number} end
 * @param {string|null} symbolName
 * @param {number} maxLines - positive integer window size
 * @returns {{startLine:number,endLine:number,symbol:string|null}[]}
 */
function windowRange(start, end, symbolName, maxLines) {
  const chunks = [];
  if (start > end) return chunks;

  for (let s = start; s <= end; s += maxLines) {
    const e = Math.min(s + maxLines - 1, end);
    chunks.push({ startLine: s, endLine: e, symbol: symbolName });
  }

  return chunks;
}

/**
 * chunkFile(text, symbols, opts) → [{ startLine, endLine, symbol|null }]
 *
 * Covers the whole file (lines 1..totalLines, using the same '\n'-split line
 * counting convention as util.readLines) with no gaps and no overlaps.
 * Symbol ranges are preferred as chunk boundaries; a symbol longer than
 * `opts.chunkMaxLines` is split into consecutive same-named windows. Any
 * line range not covered by a symbol is windowed the same way with
 * `symbol: null`.
 *
 * Symbols are expected to already be non-overlapping (extractSymbols derives
 * each symbol's endLine from the next symbol's start line), but this
 * function defensively clips/resolves any overlap in favor of whichever
 * symbol starts first, so the output is always a valid partition of the
 * file regardless of upstream quirks.
 *
 * @param {string} text - full file contents
 * @param {{name:string,kind:string,line:number,endLine:number}[]} symbols - 1-based
 * @param {{chunkMaxLines?:number}} [opts]
 * @returns {{startLine:number,endLine:number,symbol:string|null}[]}
 */
export function chunkFile(text, symbols, opts) {
  const totalLines = text.split('\n').length;
  if (totalLines < 1) return [];

  const rawMax = opts && opts.chunkMaxLines;
  const maxLines =
    Number.isFinite(rawMax) && rawMax >= 1 ? Math.floor(rawMax) : DEFAULT_CHUNK_MAX_LINES;

  // Normalize + clip symbols to the file's actual line range, drop anything
  // that ends up empty/out of bounds, and sort left-to-right so we can walk
  // the file once.
  const normalized = (Array.isArray(symbols) ? symbols : [])
    .map((s) => ({
      name: s.name,
      line: Math.max(1, Math.min(Math.floor(s.line), totalLines)),
      endLine: Math.max(1, Math.min(Math.floor(s.endLine), totalLines)),
    }))
    .filter((s) => s.line <= s.endLine)
    .sort((a, b) => a.line - b.line || a.endLine - b.endLine);

  const chunks = [];
  let cursor = 1;

  for (const sym of normalized) {
    const start = Math.max(sym.line, cursor);
    const end = sym.endLine;

    if (start > end) {
      // Fully engulfed by a preceding (earlier-starting) symbol's chunk(s).
      continue;
    }

    if (start > cursor) {
      // Un-symboled gap before this symbol.
      chunks.push(...windowRange(cursor, start - 1, null, maxLines));
    }

    chunks.push(...windowRange(start, end, sym.name, maxLines));
    cursor = end + 1;
  }

  if (cursor <= totalLines) {
    // Trailing un-symboled region (or the whole file, if no symbols at all).
    chunks.push(...windowRange(cursor, totalLines, null, maxLines));
  }

  return chunks;
}
