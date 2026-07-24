// src/outline.js
// Compact textual outlines over already-built index data: `outlineFile` renders
// a single file's symbol list, `outlineRepo` renders a directory-grouped tree
// of the whole repo (or a subtree, via opts.dir). Pure string formatting only
// — no disk access, no randomness, byte-stable for a given index.

import { toPosix } from './util.js';

/**
 * Render a per-symbol outline for a single indexed file record: the file's
 * path on the first line, then one indented line per symbol in the form
 * `  kind name  (Lstart-Lend)`, in the same order as `fileRecord.symbols`.
 *
 * @param {{path: string, symbols?: Array<{name:string, kind:string, line:number, endLine:number}>}} fileRecord
 * @returns {string}
 */
export function outlineFile(fileRecord) {
  const lines = [fileRecord.path];
  const symbols = fileRecord.symbols || [];

  for (const sym of symbols) {
    lines.push(`  ${sym.kind} ${sym.name}  (L${sym.line}-L${sym.endLine})`);
  }

  return lines.join('\n');
}

/**
 * Render a compact, directory-grouped outline tree of the repo.
 *
 * Builds a tree from `index.files[].path` (POSIX relative paths). Each
 * directory level is rendered as `<name>/` followed by its nested entries
 * indented two spaces further; each file is rendered as `<name>` followed by
 * a parenthesized, comma-joined `kind name` summary of its symbols (omitted
 * when the file has none). At every level, directories are listed before
 * files, and each group is sorted ascending by name (plain string comparison,
 * not locale-aware) so output is deterministic regardless of input order or
 * host locale.
 *
 * If `opts.dir` is given, only files at or under that POSIX-relative subtree
 * are included (equivalent to restricting `index.files` to that prefix
 * before building the tree); if nothing matches, a one-line placeholder is
 * returned instead of an empty string.
 *
 * @param {{files: Array<{path: string, symbols?: Array<{name:string, kind:string}>}>}} index
 * @param {{dir?: string}} [opts]
 * @returns {string}
 */
export function outlineRepo(index, opts = {}) {
  let files = index.files || [];

  if (opts.dir) {
    const dirNorm = toPosix(opts.dir).replace(/\/+$/, '');
    files = files.filter(
      (f) => f.path === dirNorm || f.path.startsWith(`${dirNorm}/`)
    );
    if (files.length === 0) {
      return `(no files under ${dirNorm})`;
    }
  }

  const root = makeNode();
  for (const file of files) {
    const parts = file.path.split('/');
    const name = parts.pop();
    let node = root;
    for (const part of parts) {
      if (!node.dirs.has(part)) {
        node.dirs.set(part, makeNode());
      }
      node = node.dirs.get(part);
    }
    node.files.push({ name, symbols: file.symbols || [] });
  }

  return renderNode(root, '').join('\n');
}

function makeNode() {
  return { dirs: new Map(), files: [] };
}

function byName(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function renderNode(node, indent) {
  const lines = [];

  const dirNames = [...node.dirs.keys()].sort(byName);
  for (const dirName of dirNames) {
    lines.push(`${indent}${dirName}/`);
    lines.push(...renderNode(node.dirs.get(dirName), `${indent}  `));
  }

  const sortedFiles = [...node.files].sort((a, b) => byName(a.name, b.name));
  for (const file of sortedFiles) {
    const summary = file.symbols.length
      ? ` (${file.symbols.map((s) => `${s.kind} ${s.name}`).join(', ')})`
      : '';
    lines.push(`${indent}${file.name}${summary}`);
  }

  return lines;
}
