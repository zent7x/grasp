// src/graph.js
//
// Builds the repo import graph from indexed file records and answers
// neighbor queries against it. Pure (no disk access): callers pass in the
// already-extracted `files[]` (each `{ path, imports, ... }`) from the index.

import path from 'node:path';

/**
 * Resolve a single relative import specifier (one that starts with ".") to
 * an actual repo file path, given the importer's directory and the set of
 * known repo file paths. Tries, in order: as-is, then with a `.js`/`.ts`/
 * `.py` extension appended, then as a directory's `/index.js`.
 *
 * @param {string} importerDir - POSIX dirname of the importing file
 * @param {string} spec - raw relative specifier, e.g. "../auth.js" or "./x"
 * @param {Set<string>} filePathSet - set of all known repo file paths (POSIX)
 * @returns {string|null} resolved repo file path, or null if none match
 */
function resolveRelativeImport(importerDir, spec, filePathSet) {
  const joined = path.posix.normalize(path.posix.join(importerDir, spec));

  const candidates = [
    joined,
    `${joined}.js`,
    `${joined}.ts`,
    `${joined}.py`,
    path.posix.join(joined, 'index.js'),
  ];

  for (const candidate of candidates) {
    if (filePathSet.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Build the repo import graph from indexed file records.
 *
 * Only specifiers beginning with "." are resolved (bare specifiers like
 * "os" or "react" are dropped — they don't point at a repo file). Resolution
 * is relative to the importer's POSIX dirname. Both `out` and `in` are plain
 * objects keyed by POSIX file path, containing an entry ONLY for files with
 * at least one resolved edge (never an empty array).
 *
 * @param {Array<{path: string, imports?: string[]}>} files - index files[]
 * @returns {{out: Object<string,string[]>, in: Object<string,string[]>}}
 */
export function buildGraph(files) {
  const filePathSet = new Set(files.map((f) => f.path));

  // Maps avoid collisions with Object.prototype for legal repo paths such as
  // "constructor", "toString", and "__proto__". We convert back to the
  // schema's plain-object representation at the boundary.
  const out = new Map();
  const inEdges = new Map();

  for (const file of files) {
    const importer = file.path;
    const importerDir = path.posix.dirname(importer);
    const specifiers = file.imports || [];

    const seen = new Set();
    const resolvedTargets = [];

    for (const spec of specifiers) {
      if (!spec.startsWith('.')) continue;

      const target = resolveRelativeImport(importerDir, spec, filePathSet);
      if (target && target !== importer && !seen.has(target)) {
        seen.add(target);
        resolvedTargets.push(target);
      }
    }

    if (resolvedTargets.length === 0) continue;

    out.set(importer, resolvedTargets);

    for (const target of resolvedTargets) {
      if (!inEdges.has(target)) {
        inEdges.set(target, []);
      }
      if (!inEdges.get(target).includes(importer)) {
        inEdges.get(target).push(importer);
      }
    }
  }

  return { out: Object.fromEntries(out), in: Object.fromEntries(inEdges) };
}

/**
 * BFS outward from `start` through `adjacency` up to `depth` hops, collecting
 * every newly-reached node (excluding `start` itself) into `result`.
 *
 * @param {Object<string,string[]>} adjacency
 * @param {string} start
 * @param {number} depth
 * @returns {string[]} reached nodes in BFS discovery order, deduped
 */
function bfsCollect(adjacency, start, depth) {
  const visited = new Set([start]);
  const result = [];

  let frontier = [start];
  for (let hop = 0; hop < depth && frontier.length > 0; hop++) {
    const next = [];
    for (const node of frontier) {
      const nodeNeighbors = Object.hasOwn(adjacency, node) ? adjacency[node] : [];
      for (const n of nodeNeighbors) {
        if (!visited.has(n)) {
          visited.add(n);
          result.push(n);
          next.push(n);
        }
      }
    }
    frontier = next;
  }

  return result;
}

/**
 * Find a file's graph neighbors up to `depth` hops away.
 *
 * @param {{out: Object<string,string[]>, in: Object<string,string[]>}} graph
 * @param {string} filePath - POSIX repo path to center the search on
 * @param {number} [depth=1] - BFS depth
 * @returns {{imports: string[], importedBy: string[]}} deduped, self excluded
 */
export function neighbors(graph, filePath, depth = 1) {
  const imports = bfsCollect(graph.out || {}, filePath, depth);
  const importedBy = bfsCollect(graph.in || {}, filePath, depth);

  return { imports, importedBy };
}
