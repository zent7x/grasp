// src/tui.js
//
// `grasp tui` — an interactive, zero-dependency search shell. Type a query to
// rank the codebase; type a result number to open that chunk's source; `q` (or
// Ctrl-D) to quit. Built on node:readline + ANSI only, so it degrades cleanly
// when stdin/stdout aren't a TTY (e.g. piped input in tests): it still reads a
// line at a time and prints uncolored output.

import readline from 'node:readline';
import path from 'node:path';

import { loadIndex } from './store.js';
import { buildIndex } from './index-build.js';
import { loadConfig } from './config.js';
import { rank } from './rank.js';
import { safeResolve, readLines } from './util.js';
import { stylerFor } from './color.js';

const HELP = 'Type a query · a number to open a result · `p <query>` to pack · `q` to quit';

function header(c, root, index) {
  const name = path.basename(path.resolve(root));
  const bar = c.dim('─'.repeat(Math.min(56, Math.max(24, name.length + 28))));
  return [
    `${c.bold(c.cyan('grasp'))} ${c.dim('·')} ${c.bold(name)}  ${c.dim('·')}  ` +
      `${c.yellow(String(index.fileCount))} files, ${c.yellow(String(index.chunkCount))} chunks`,
    c.dim(HELP),
    bar,
  ].join('\n');
}

function formatResult(c, r, i) {
  const n = c.dim(String(i + 1).padStart(2));
  const loc = `${c.cyan(r.file)}${c.dim(`:L${r.startLine}-${r.endLine}`)}`;
  const sym = r.symbol ? ` ${c.magenta(`[${r.symbol}]`)}` : '';
  const score = c.dim(r.score.toFixed(2));
  return `${n}  ${loc}${sym}  ${score}`;
}

async function preview(c, root, r, out) {
  const abs = safeResolve(root, r.file);
  const code = await readLines(abs, r.startLine, r.endLine);
  const width = String(r.endLine).length;
  out.write(`${c.dim('┌ ')}${c.cyan(r.file)}${c.dim(`:${r.startLine}-${r.endLine}`)}\n`);
  const lines = code.split('\n');
  // Drop a single trailing empty line from the range read, for tidiness.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  lines.forEach((line, idx) => {
    const ln = c.dim(String(r.startLine + idx).padStart(width));
    out.write(`${c.dim('│')} ${ln}  ${line}\n`);
  });
  out.write(`${c.dim('└')}\n`);
}

/**
 * Start the interactive TUI. Resolves when the user quits (q / Ctrl-D).
 * @param {{ root: string, top?: number }} opts
 */
export async function startTui(opts = {}) {
  const root = opts.root || process.cwd();
  const out = process.stdout;
  const c = stylerFor(out);

  const config = await loadConfig(root);
  const top = opts.top ?? Math.min(config.top, 10);

  let index = await loadIndex(root);
  if (!index) {
    out.write(c.dim('no index found — building one…\n'));
    index = await buildIndex(root, config);
  }

  out.write(`${header(c, root, index)}\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: out,
    prompt: c.cyan('grasp ❯ '),
  });

  let last = [];
  let closed = false;

  return new Promise((resolve) => {
    rl.prompt();

    rl.on('line', async (raw) => {
      const line = raw.trim();
      try {
        if (line === '' ) {
          // reprompt below
        } else if (line === 'q' || line === 'quit' || line === 'exit') {
          closed = true;
          rl.close();
          return;
        } else if (line === 'help' || line === '?') {
          out.write(`${c.dim(HELP)}\n`);
        } else if (/^p\s+/.test(line)) {
          const { pack } = await import('./pack.js');
          const task = line.replace(/^p\s+/, '');
          const bundle = await pack(index, root, task, { budget: config.budget, top });
          out.write(`${bundle.text}\n`);
          out.write(c.dim(`~${bundle.tokens} tokens, ${bundle.included.length} chunk(s)\n`));
        } else if (/^\d+$/.test(line)) {
          const idx = Number(line) - 1;
          if (idx >= 0 && idx < last.length) {
            await preview(c, root, last[idx], out);
          } else {
            out.write(c.dim(`no result #${line} — run a query first\n`));
          }
        } else {
          const { results } = { results: rank(index, line, { top }) };
          last = results;
          if (results.length === 0) {
            out.write(c.dim('no matches\n'));
          } else {
            results.forEach((r, i) => out.write(`${formatResult(c, r, i)}\n`));
          }
        }
      } catch (err) {
        out.write(c.red(`error: ${err && err.message ? err.message : String(err)}`) + '\n');
      }
      if (!closed) rl.prompt();
    });

    rl.on('close', () => {
      closed = true;
      out.write(c.dim('bye\n'));
      resolve();
    });
  });
}
