// src/index-build.js
//
// Orchestrates the full indexing pipeline described by SPEC.md's "Index JSON
// schema" section: walk the repo, extract symbols/imports/chunks per file,
// tokenize each chunk's text for BM25, build the import graph, and assemble
// the persisted index object. Unless `opts.noSave` is truthy, the result is
// written to `<root>/.grasp/index.json` via src/store.js.
//
// Pure orchestration only — all real work (walking, language rules, symbol/
// import extraction, chunking, BM25, graph resolution) lives in the sibling
// modules this file imports; nothing here reimplements their behavior.

import path from 'node:path';
import { walkRepo } from './walk.js';
import { loadConfig } from './config.js';
import { detectLang } from './lang.js';
import { extractSymbols } from './symbols.js';
import { extractImports } from './imports.js';
import { chunkFile } from './chunk.js';
import { tokenize } from './tokenize.js';
import { buildBM25 } from './bm25.js';
import { buildGraph } from './graph.js';
import { safeResolve, readLines, hashString } from './util.js';
import { saveIndex } from './store.js';

/**
 * Build (and, unless `opts.noSave`, persist) the full repo index.
 *
 * Pipeline: walkRepo -> for each file { read, detectLang, count lines, hash,
 * extractSymbols, extractImports, chunkFile } -> assign chunk ids
 * "<fileIndex>:<chunkIndex>" -> build BM25 docs (tokens = tokenize of each
 * chunk's text, re-read from disk via util.readLines) -> buildBM25 ->
 * buildGraph -> assemble the index object. `bm25.chunkMeta` is populated for
 * every chunk so `rank` (pure, no disk access) can resolve a scored chunkId
 * back to `{file, startLine, endLine, symbol}` solely from the index.
 *
 * @param {string} root - repo root (resolved to an absolute path here)
 * @param {object} [opts] - overrides merged over loadConfig(root); recognized
 *   config-shaped keys include maxFileSize and chunkMaxLines (consumed by
 *   walkRepo / chunkFile respectively). `opts.noSave` (not part of config)
 *   skips persisting the built index to disk when truthy.
 * @returns {Promise<object>} the assembled index object (see SPEC.md schema)
 */
export async function buildIndex(root, opts = {}) {
  const absRoot = path.resolve(root);
  const config = await loadConfig(absRoot);
  const merged = { ...config, ...opts };

  const walked = await walkRepo(absRoot, merged);

  const files = [];
  const bm25Docs = [];

  for (let fileIndex = 0; fileIndex < walked.length; fileIndex++) {
    const relPath = walked[fileIndex].path;
    const absPath = safeResolve(absRoot, relPath);

    const text = await readLines(absPath);
    const lang = detectLang(relPath);
    const lines = text.split('\n').length;
    const hash = hashString(text);
    const symbols = extractSymbols(text, lang);
    const imports = extractImports(text, lang);
    const ranges = chunkFile(text, symbols, merged);

    const chunks = [];
    for (let chunkIndex = 0; chunkIndex < ranges.length; chunkIndex++) {
      const range = ranges[chunkIndex];
      const id = `${fileIndex}:${chunkIndex}`;

      chunks.push({
        id,
        startLine: range.startLine,
        endLine: range.endLine,
        symbol: range.symbol,
      });

      // Re-read this chunk's exact text from disk (rather than slicing the
      // already-in-memory `text`) so tokenization goes through the same
      // util.readLines line-slicing semantics that pack.js/grasp_read rely
      // on elsewhere — the index itself never stores chunk text.
      const chunkText = await readLines(absPath, range.startLine, range.endLine);
      bm25Docs.push({ id, tokens: tokenize(chunkText) });
    }

    files.push({
      path: relPath,
      lang,
      size: walked[fileIndex].size,
      lines,
      hash,
      symbols,
      imports,
      chunks,
    });
  }

  const { N, avgdl, df, postings, docLen } = buildBM25(bm25Docs);

  const chunkMeta = {};
  for (const file of files) {
    for (const chunk of file.chunks) {
      chunkMeta[chunk.id] = {
        file: file.path,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        symbol: chunk.symbol,
      };
    }
  }

  const graph = buildGraph(files);

  const index = {
    version: 1,
    root: absRoot,
    createdAt: Date.now(),
    fileCount: files.length,
    chunkCount: bm25Docs.length,
    files,
    bm25: { N, avgdl, df, postings, docLen, chunkMeta },
    graph,
  };

  if (!opts.noSave) {
    await saveIndex(absRoot, index);
  }

  return index;
}
