// src/walk.js
//
// Recursively walks a repository directory tree, producing the flat list of
// candidate files the rest of the pipeline (index-build, etc.) will read and
// process. Respects .gitignore, skips oversized files, and skips binary
// files (by extension blocklist or NUL-byte sniffing). Never recurses into
// ignored directories, and never follows symlinks (keeps traversal safely
// inside `root` and avoids symlink cycles).

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { loadGitignore } from './gitignore.js';
import { DEFAULTS } from './config.js';
import { safeResolve, toPosix } from './util.js';

// Extensions always treated as binary, regardless of content.
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tiff', '.ico',
  '.pdf', '.zip', '.gz', '.bin', '.exe', '.wasm',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp4', '.mp3', '.mov', '.avi', '.webm', '.ogg', '.wav', '.flac',
  '.tar', '.7z', '.rar', '.jar', '.class', '.pyc',
  '.so', '.dylib', '.dll', '.o', '.a', '.node',
  '.db', '.sqlite', '.sqlite3',
]);

// Directory names that are never walked into, independent of .gitignore
// content. This is defense in depth: loadGitignore's contract already
// guarantees these are reported as ignored, but walk never even attempts to
// read them.
const ALWAYS_IGNORED_DIRS = new Set(['.git', 'node_modules', '.grasp']);

// Number of leading bytes inspected for a NUL byte when sniffing for binary
// content.
const SNIFF_BYTES = 8192;

/**
 * Recursively walk `root`, returning the list of files eligible for
 * indexing: not gitignored, not over the size limit, and not binary.
 *
 * @param {string} root - absolute path to the repo root.
 * @param {object} [opts] - overrides merged over config.DEFAULTS (only
 *   `maxFileSize` is consulted by walk itself).
 * @returns {Promise<Array<{path: string, absPath: string, size: number}>>}
 */
export async function walkRepo(root, opts = {}) {
  const { maxFileSize } = { ...DEFAULTS, ...opts };
  const isIgnored = await loadGitignore(root);
  const results = [];

  async function walk(absDir, relDirOS, isRoot) {
    let entries;
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true });
    } catch (err) {
      if (isRoot) {
        throw new Error(`walkRepo: cannot read directory "${absDir}": ${err.message}`);
      }
      // A subdirectory that vanished or is unreadable (permissions, race
      // with a concurrent delete) should not abort the whole walk.
      return;
    }

    // Sort for deterministic traversal order across filesystems/OSes.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      const name = entry.name;

      // Never follow symlinks: keeps traversal safely inside `root` and
      // avoids symlink cycles.
      if (entry.isSymbolicLink()) continue;

      const relPathOS = relDirOS ? path.join(relDirOS, name) : name;
      const relPosix = toPosix(relPathOS);
      // Route every candidate through the repository containment guard before
      // stat/open/readdir touches it, as required by the global safety rule.
      const absPath = safeResolve(root, relPathOS);

      if (entry.isDirectory()) {
        if (ALWAYS_IGNORED_DIRS.has(name)) continue;
        // Check both with and without a trailing slash so we're compatible
        // regardless of whether the gitignore matcher expects directory
        // patterns to be probed with a trailing slash.
        if (isIgnored(relPosix) || isIgnored(`${relPosix}/`)) continue;
        await walk(absPath, relPathOS, false);
        continue;
      }

      if (!entry.isFile()) continue; // skip fifos, sockets, char/block devices

      if (isIgnored(relPosix)) continue;

      const ext = path.extname(name).toLowerCase();
      if (BINARY_EXTENSIONS.has(ext)) continue;

      let stat;
      try {
        stat = await fsp.stat(absPath);
      } catch {
        continue; // e.g. broken permissions, race with deletion
      }

      if (stat.size > maxFileSize) continue;

      if (await looksBinary(absPath)) continue;

      results.push({ path: relPosix, absPath, size: stat.size });
    }
  }

  await walk(root, '', true);

  // Final sort keeps the result byte-stable regardless of any filesystem
  // ordering quirks not already normalized by the per-directory sort above.
  results.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return results;
}

/**
 * Sniff the first SNIFF_BYTES of a file for a NUL byte, a strong signal of
 * binary content for files that didn't already match the extension
 * blocklist.
 */
async function looksBinary(absPath) {
  const handle = await fsp.open(absPath, 'r');
  try {
    const buf = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buf, 0, SNIFF_BYTES, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  } finally {
    await handle.close();
  }
}
