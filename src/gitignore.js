// src/gitignore.js — root-level .gitignore parsing for grasp's file walker.
// Converts .gitignore patterns to RegExps and returns a single matcher function
// `(relPosixPath) => boolean` (true = ignored). Always ignores .git/, node_modules/,
// and .grasp/ regardless of .gitignore contents.

import { safeResolve, readLines } from './util.js';

const ALWAYS_IGNORED = ['.git/', 'node_modules/', '.grasp/'];

// Escape a single character for safe inclusion in a RegExp, except '/' which
// needs no escaping and is left as a literal path separator.
function escapeRegexChar(ch) {
  return ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

// Convert one .gitignore pattern line into a RegExp matching POSIX-relative paths.
//
// Supported syntax:
//   - leading `/`      → anchor the pattern to the repo root
//   - trailing `/`     → pattern only meant to match a directory (and everything under it)
//   - `**`             → matches across path segments (zero or more directories)
//   - `*`               → matches within a single path segment
//   - `?`               → matches a single non-separator character
//   - a pattern with no interior `/` (ignoring a trailing one) is NOT anchored,
//     i.e. it can match at any depth, mirroring real gitignore semantics.
function patternToRegex(pattern) {
  let pat = pattern;

  let anchored = false;
  if (pat.startsWith('/')) {
    anchored = true;
    pat = pat.slice(1);
  }

  const directoryOnly = pat.endsWith('/');
  if (directoryOnly) {
    pat = pat.slice(0, -1);
  }

  // A slash anywhere in the remaining pattern (other than the trailing one we
  // just stripped) anchors it relative to the .gitignore's directory (root, in v0.1).
  if (!anchored && pat.includes('/')) {
    anchored = true;
  }

  let body = '';
  for (let i = 0; i < pat.length; i++) {
    const ch = pat[i];

    if (ch === '*' && pat[i + 1] === '*') {
      const prevSlash = i === 0 || pat[i - 1] === '/';
      const nextSlash = pat[i + 2] === '/';
      const isTrailing = i + 2 === pat.length;

      if (prevSlash && nextSlash) {
        // "a/**/b" — zero or more path segments
        body += '(?:.*/)?';
        i += 2; // consume the extra '*' and the following '/'
      } else if (prevSlash && isTrailing) {
        // "a/**" — everything below a/
        body += '.*';
        i += 1; // consume the extra '*'
      } else {
        // "**" not aligned to segment boundaries — best-effort fallback
        body += '.*';
        i += 1;
      }
      continue;
    }

    if (ch === '*') {
      body += '[^/]*';
    } else if (ch === '?') {
      body += '[^/]';
    } else {
      body += escapeRegexChar(ch);
    }
  }

  const prefix = anchored ? '' : '(?:.*/)?';
  // A match may be the pattern itself, or the pattern followed by a path
  // separator and more (i.e. the pattern names a directory and anything below
  // it is ignored too).
  // A trailing slash is semantically meaningful: it targets directories,
  // not a regular file with the same name. Directory probes from walkRepo
  // carry a trailing slash, and descendants naturally contain one.
  const suffix = directoryOnly ? '/.*' : '(?:/.*)?';

  return new RegExp(`^${prefix}${body}${suffix}$`);
}

function parsePatterns(text) {
  const patterns = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    // Negation (`!pattern`) is not supported in v0.1; skip rather than
    // mis-ignore something the user meant to un-ignore.
    if (line.startsWith('!')) continue;
    patterns.push(line);
  }
  return patterns;
}

/**
 * Load `<root>/.gitignore` (root-level only; nested .gitignore files are not
 * supported in v0.1) and return a matcher function.
 *
 * @param {string} root - absolute repo root
 * @returns {Promise<(relPosixPath: string) => boolean>}
 */
export async function loadGitignore(root) {
  let patterns = [];

  try {
    const absPath = safeResolve(root, '.gitignore');
    const text = await readLines(absPath);
    patterns = parsePatterns(text);
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
    // No .gitignore present — fall through with just the always-ignored set.
  }

  for (const p of ALWAYS_IGNORED) {
    if (!patterns.includes(p)) patterns.push(p);
  }

  const regexes = patterns.map(patternToRegex);

  return function isIgnored(relPosixPath) {
    return regexes.some((re) => re.test(relPosixPath));
  };
}
