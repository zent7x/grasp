// src/cli.js
//
// Command-line entry point for grasp. `bin/grasp.js` calls `run(process.argv.slice(2))`
// so `argv` here is just the command + its arguments (no node/script path entries).
//
// Commands: index | ask | pack | outline | stats | serve | help | version.
// Every command that needs a repo root defaults to `process.cwd()`; only `index`
// accepts an explicit `[path]` to point at a different repo.
//
// Per the global "Errors" convention, sibling modules throw plain `Error`s with
// clear messages — this layer is responsible for catching them and formatting
// something readable on stderr instead of letting a raw stack trace through.

import path from 'node:path';
import { writeFile } from 'node:fs/promises';

import { buildIndex } from './index-build.js';
import { query } from './query.js';
import { pack } from './pack.js';
import { outlineRepo, outlineFile } from './outline.js';
import { loadIndex } from './store.js';
import { loadConfig } from './config.js';
import { toPosix } from './util.js';
import { startServer } from './mcp/server.js';
import { stylerFor } from './color.js';
import { startTui } from './tui.js';

const VERSION = '0.1.0';

const NO_INDEX_MESSAGE =
  'No grasp index found for this repo. Run `grasp index` first to build one.';

const USAGE = `grasp v${VERSION}
Give any AI coding agent a grasp on a codebase too big to fit in its context window.

Usage:
  grasp index [path]                    Build (or rebuild) the index for a repo.
  grasp ask <task...> [--top N] [--json] [--tests]
                                         Rank the codebase against a task description.
                                         (test/fixture files are demoted by default; --tests includes them)
  grasp pack <task...> [--budget N] [--out FILE] [--tests]
                                         Pack the most relevant code for a task into a bundle.
  grasp outline [path]                  Show a symbol outline (whole repo, or one file/dir).
  grasp stats                           Print index summary statistics.
  grasp tui [--top N]                   Interactive search shell: query, open results, pack.
  grasp serve                           Start the MCP server (newline-delimited JSON-RPC over stdio).
  grasp help                            Show this help.
  grasp version                         Print the version number.

Output is colorized on a TTY; set NO_COLOR=1 to disable.
`;

/**
 * Parse a raw args array into positional arguments and flags.
 *
 * @param {string[]} rest
 * @param {{ valueFlags?: string[], boolFlags?: string[] }} [spec]
 * @returns {{ positional: string[], flags: Record<string, string|boolean> }}
 */
function parseArgs(rest, spec = {}) {
  const valueFlags = spec.valueFlags || [];
  const boolFlags = spec.boolFlags || [];
  const positional = [];
  const flags = {};

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (valueFlags.includes(arg)) {
      const key = arg.replace(/^--/, '');
      flags[key] = rest[i + 1];
      i += 1;
    } else if (boolFlags.includes(arg)) {
      const key = arg.replace(/^--/, '');
      flags[key] = true;
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags };
}

function formatResultLine(r, c) {
  const path = c.cyan(r.file);
  const loc = c.dim(`:L${r.startLine}-${r.endLine}`);
  const symbolPart = r.symbol ? ` ${c.magenta(`[${r.symbol}]`)}` : '';
  const score = typeof r.score === 'number' ? r.score.toFixed(2) : String(r.score);
  // With colors disabled every styler is the identity function, so this is
  // byte-for-byte `file:Lstart-end [symbol] score` — the pipe/test format.
  return `${path}${loc}${symbolPart} ${c.dim(score)}`;
}

async function requireIndex(root) {
  const index = await loadIndex(root);
  if (!index) {
    throw new Error(NO_INDEX_MESSAGE);
  }
  return index;
}

async function runIndex(rest) {
  const { positional } = parseArgs(rest);
  const root = positional[0] ? path.resolve(process.cwd(), positional[0]) : process.cwd();
  const config = await loadConfig(root);
  const index = await buildIndex(root, config);
  const c = stylerFor(process.stdout);
  console.log(
    `indexed ${c.green(String(index.fileCount))} files, ${c.green(String(index.chunkCount))} chunks → ${c.dim('.grasp/index.json')}`
  );
}

async function runAsk(rest) {
  const { positional, flags } = parseArgs(rest, {
    valueFlags: ['--top'],
    boolFlags: ['--json', '--tests'],
  });
  if (positional.length === 0) {
    throw new Error('ask requires a task, e.g. `grasp ask "add auth to login route"`');
  }
  const task = positional.join(' ');
  const root = process.cwd();
  const config = await loadConfig(root);
  const top = flags.top !== undefined ? Number(flags.top) : config.top;

  const { results } = await query(root, task, { top, includeTests: flags.tests === true });

  if (flags.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  const c = stylerFor(process.stdout);
  for (const r of results) {
    console.log(formatResultLine(r, c));
  }
}

async function runPack(rest) {
  const { positional, flags } = parseArgs(rest, {
    valueFlags: ['--budget', '--out'],
    boolFlags: ['--tests'],
  });
  if (positional.length === 0) {
    throw new Error('pack requires a task, e.g. `grasp pack "add auth to login route"`');
  }
  const task = positional.join(' ');
  const root = process.cwd();
  const index = await requireIndex(root);
  const config = await loadConfig(root);
  const budget = flags.budget !== undefined ? Number(flags.budget) : config.budget;

  const result = await pack(index, root, task, { budget, includeTests: flags.tests === true });

  if (flags.out) {
    const outPath = path.resolve(process.cwd(), flags.out);
    await writeFile(outPath, result.text, 'utf8');
  } else {
    process.stdout.write(result.text.endsWith('\n') ? result.text : `${result.text}\n`);
  }

  console.error(
    `packed ${result.tokens} tokens (budget ${budget}) — ${result.included.length} chunk(s) included, ${result.trimmed.length} file(s) trimmed`
  );
}

async function runOutline(rest) {
  const { positional } = parseArgs(rest);
  const root = process.cwd();
  const index = await requireIndex(root);

  const target = positional[0];
  if (!target) {
    console.log(outlineRepo(index, {}));
    return;
  }

  const normalized = toPosix(target);
  const fileRecord = index.files.find((f) => f.path === normalized);
  if (fileRecord) {
    console.log(outlineFile(fileRecord));
    return;
  }

  console.log(outlineRepo(index, { dir: normalized }));
}

async function runStats(rest) {
  const root = process.cwd();
  const index = await requireIndex(root);

  const langCounts = new Map();
  for (const f of index.files) {
    langCounts.set(f.lang, (langCounts.get(f.lang) || 0) + 1);
  }
  const sortedLangs = [...langCounts.entries()].sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
  );

  const c = stylerFor(process.stdout);
  console.log(`${c.dim('files:')} ${c.yellow(String(index.fileCount))}`);
  console.log(`${c.dim('chunks:')} ${c.yellow(String(index.chunkCount))}`);
  console.log(`${c.dim('languages:')}`);
  for (const [lang, count] of sortedLangs) {
    console.log(`  ${c.cyan(lang)}: ${count}`);
  }
}

async function runTui(rest) {
  const { flags } = parseArgs(rest, { valueFlags: ['--top'] });
  const root = process.cwd();
  const top = flags.top !== undefined ? Number(flags.top) : undefined;
  await startTui({ root, top });
}

async function runServe() {
  const root = process.cwd();
  await startServer({ root });
}

/**
 * CLI dispatch. `argv` is already sliced by `bin/grasp.js` (no node/script
 * path entries) — argv[0] is the command name.
 *
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
export async function run(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const [cmd, ...rest] = args;

  if (!cmd || cmd === 'help' || cmd === '--help') {
    process.stdout.write(USAGE);
    return;
  }

  if (cmd === 'version' || cmd === '--version') {
    console.log(VERSION);
    return;
  }

  try {
    switch (cmd) {
      case 'index':
        await runIndex(rest);
        break;
      case 'ask':
        await runAsk(rest);
        break;
      case 'pack':
        await runPack(rest);
        break;
      case 'outline':
        await runOutline(rest);
        break;
      case 'stats':
        await runStats(rest);
        break;
      case 'serve':
        await runServe(rest);
        break;
      case 'tui':
        await runTui(rest);
        break;
      default:
        throw new Error(`unknown command: "${cmd}"\n\n${USAGE}`);
    }
  } catch (err) {
    console.error(`grasp: ${err && err.message ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
