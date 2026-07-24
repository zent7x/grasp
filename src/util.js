// src/util.js
//
// Small, pure filesystem/path/hash/string helpers shared across grasp. Every
// disk read of repo content elsewhere in the codebase MUST route the path
// through safeResolve() first — this is the one place path-traversal safety
// is enforced.

import { createHash } from 'node:crypto';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';

/**
 * Resolve `rel` (a path relative to `root`) to an absolute path, guaranteeing
 * the result stays inside `root`. Throws on `..` traversal and on absolute
 * `rel` inputs.
 *
 * @param {string} root - absolute repo root
 * @param {string} rel - path relative to root (POSIX or OS-native separators)
 * @returns {string} absolute path inside root
 */
export function safeResolve(root, rel) {
  if (path.isAbsolute(rel)) {
    throw new Error('path escapes root');
  }

  const absRoot = path.resolve(root);
  const resolved = path.resolve(absRoot, rel);

  // Ensure resolved is absRoot itself or strictly inside it. Compare with a
  // trailing separator so "/root-evil" cannot pass a naive startsWith("/root")
  // check against "/root".
  if (!isInside(absRoot, resolved)) {
    throw new Error('path escapes root');
  }

  // The string check above only defeats textual traversal (`..`, absolute
  // rel). It cannot see symlinks: a link *inside* root can still point
  // *outside* it, and a plain readFile() would follow it, leaking arbitrary
  // files (e.g. /etc/passwd). Resolve the real path of the longest existing
  // prefix of `resolved` and require it to stay inside the real root, honoring
  // the SPEC's "Never follow symlinks outside root." The final component may
  // legitimately not exist yet (e.g. .grasp/index.json before first write), so
  // we walk up to the nearest existing ancestor.
  assertNoSymlinkEscape(absRoot, resolved);

  return resolved;
}

/**
 * True if `target` is `base` itself or strictly contained within it, using a
 * trailing-separator comparison so "/root-evil" is not treated as inside
 * "/root".
 */
function isInside(base, target) {
  if (target === base) return true;
  const baseWithSep = base.endsWith(path.sep) ? base : base + path.sep;
  return target.startsWith(baseWithSep);
}

/**
 * Throw if any symlink along `resolved` redirects the real, canonical path
 * outside the real, canonical `absRoot`. Non-existent tail components are fine
 * (a path that does not exist cannot be a symlink to elsewhere); only existing
 * components are canonicalized. Comparing real-vs-real keeps this correct even
 * when the root itself lives under a symlinked prefix (e.g. macOS /tmp ->
 * /private/tmp).
 */
function assertNoSymlinkEscape(absRoot, resolved) {
  let realRoot;
  try {
    realRoot = realpathSync(absRoot);
  } catch {
    // Root does not exist on disk; there is nothing to read and nothing a
    // symlink could redirect. The textual check already ran.
    return;
  }

  // Find the longest existing ancestor of `resolved` and canonicalize it.
  let probe = resolved;
  let realTarget;
  for (;;) {
    try {
      realTarget = realpathSync(probe);
      break;
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        const parent = path.dirname(probe);
        if (parent === probe) return; // walked to fs root without existing path
        probe = parent;
        continue;
      }
      throw err;
    }
  }

  if (!isInside(realRoot, realTarget)) {
    throw new Error('path escapes root');
  }
}

/**
 * Read 1-based inclusive line range [startLine, endLine] from a file.
 * Omitting both returns the whole file. Returns "" for an empty/invalid
 * range (e.g. startLine > endLine, or startLine beyond EOF).
 *
 * @param {string} absPath
 * @param {number} [startLine]
 * @param {number} [endLine]
 * @returns {Promise<string>}
 */
export async function readLines(absPath, startLine, endLine) {
  const text = await readFile(absPath, 'utf8');

  if (startLine == null && endLine == null) {
    return text;
  }

  // Split into lines while preserving the ability to rejoin with '\n'.
  // (Trailing newline handling: split naturally yields a final '' element
  // for a trailing '\n', which is fine — it just represents an empty last
  // line and does not affect requested ranges within real content.)
  const lines = text.split('\n');

  const start = startLine == null ? 1 : startLine;
  const end = endLine == null ? lines.length : endLine;

  if (start > end || end < 1 || start > lines.length) {
    return '';
  }

  const from = Math.max(1, start);
  const to = Math.min(lines.length, end);

  if (from > to) {
    return '';
  }

  return lines.slice(from - 1, to).join('\n');
}

/**
 * First 12 hex characters of the sha1 hash of `s`.
 * @param {string} s
 * @returns {string}
 */
export function hashString(s) {
  return createHash('sha1').update(s).digest('hex').slice(0, 12);
}

/**
 * Split an identifier into lowercased subtokens on camelCase, snake_case,
 * kebab-case, and digit boundaries. Includes the whole (lowercased) token
 * as the first element, followed by the individual pieces in order.
 *
 * e.g. splitIdentifier("getUserID") -> ["getuserid", "get", "user", "id"]
 *
 * @param {string} token
 * @returns {string[]}
 */
export function splitIdentifier(token) {
  const whole = token.toLowerCase();

  // Step 1: split on explicit separators (snake_case, kebab-case).
  const bySeparator = token.split(/[_\-]+/).filter(Boolean);

  // Step 2: within each separator-delimited piece, split on
  // camelCase / PascalCase boundaries and letter/digit boundaries.
  const pieces = [];
  for (const chunk of bySeparator) {
    // Insert a boundary between a lowercase/digit and an uppercase letter
    // (fooBar -> foo Bar), between consecutive uppercase letters followed by
    // a lowercase letter (HTTPServer -> HTTP Server), and between letters
    // and digits in either direction (v2beta -> v 2 beta, ID3 -> ID 3).
    const withBoundaries = chunk
      .replace(/([a-z])([A-Z])/g, '$1\0$2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1\0$2')
      .replace(/([A-Za-z])([0-9])/g, '$1\0$2')
      .replace(/([0-9])([A-Za-z])/g, '$1\0$2');

    for (const piece of withBoundaries.split('\0')) {
      if (piece.length > 0) {
        pieces.push(piece.toLowerCase());
      }
    }
  }

  const result = [whole];
  for (const piece of pieces) {
    // Avoid a redundant duplicate entry when the token had no boundaries at
    // all (e.g. "login" -> whole="login", pieces=["login"]).
    if (piece !== whole || pieces.length > 1) {
      result.push(piece);
    }
  }

  // Deduplicate while preserving order.
  const seen = new Set();
  const deduped = [];
  for (const t of result) {
    if (!seen.has(t)) {
      seen.add(t);
      deduped.push(t);
    }
  }

  return deduped;
}

/**
 * Convert an OS-native path to POSIX style (forward slashes).
 * @param {string} p
 * @returns {string}
 */
export function toPosix(p) {
  return p.split(path.sep).join('/');
}

/**
 * Convert a POSIX-style path to the current OS's native separator.
 * @param {string} p
 * @returns {string}
 */
export function fromPosix(p) {
  return p.split('/').join(path.sep);
}
