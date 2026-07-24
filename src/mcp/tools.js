// src/mcp/tools.js
//
// The five grasp MCP tools: search, outline, read, neighbors, pack. This
// module owns the tool catalog (TOOLS, with JSON-Schema inputSchema per SPEC's
// MCP protocol section) and the dispatcher (callTool) that turns validated
// arguments into disk reads / rank / pack / outline / graph calls and formats
// the result as a single string. mcp/server.js wraps that string as
// `{content:[{type:"text",text}]}` before writing it back over the wire.
//
// Every disk read here — including grasp_read — goes through
// util.safeResolve + util.readLines, per the global safety convention and the
// explicit contract on grasp_read. This module never re-implements ranking,
// packing, outlining, or graph traversal; it only calls the sibling modules
// that own that logic.

import { rank } from '../rank.js';
import { pack } from '../pack.js';
import { outlineFile, outlineRepo } from '../outline.js';
import { neighbors } from '../graph.js';
import { safeResolve, readLines, toPosix, fromPosix } from '../util.js';

/**
 * MCP tool catalog. Each entry's `inputSchema` is a JSON-Schema object as
 * required by the `tools/list` response (mcp/server.js maps this array to
 * `{name, description, inputSchema}` verbatim).
 */
export const TOOLS = [
  {
    name: 'grasp_search',
    description:
      'Search the indexed repo for code relevant to a query, using BM25 ' +
      'ranking with symbol-name and import-graph proximity boosts. Returns ' +
      'ranked file:line locations, most relevant first.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query or natural-language task description.',
        },
        top: {
          type: 'number',
          description: 'Maximum number of results to return (default 20).',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'grasp_outline',
    description:
      'Get a compact symbol outline. If `path` names an indexed file, ' +
      'returns that file\'s symbol list; otherwise returns a directory-' +
      'grouped outline tree of the whole repo (or the subtree at `path`).',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Repo-relative file or directory path. Omit for the whole repo.',
        },
      },
    },
  },
  {
    name: 'grasp_read',
    description:
      'Read a line-numbered slice of a file from the repo, either by ' +
      'explicit start/end line range or by symbol name.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repo-relative file path.' },
        startLine: {
          type: 'number',
          description: '1-based inclusive start line.',
        },
        endLine: {
          type: 'number',
          description: '1-based inclusive end line.',
        },
        symbol: {
          type: 'string',
          description:
            'Symbol name to read instead of an explicit line range.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'grasp_neighbors',
    description:
      'List the import-graph neighbors of a file: the files it imports and ' +
      'the files that import it, up to a given BFS depth.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repo-relative file path.' },
        depth: {
          type: 'number',
          description: 'BFS depth to search to (default 1).',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'grasp_pack',
    description:
      'Pack the most relevant code for a task into a token-budgeted ' +
      'markdown bundle, ready to paste into an agent context window.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Task description to rank and pack code for.',
        },
        budget: {
          type: 'number',
          description:
            'Approximate token budget for the packed bundle (default from config).',
        },
      },
      required: ['task'],
    },
  },
];

/**
 * Dispatch a tool call by name. Returns the text payload as a plain string;
 * the caller (mcp/server.js) is responsible for wrapping it per the MCP
 * `tools/call` response shape.
 *
 * @param {string} name - one of the TOOLS[].name values
 * @param {object} args - parsed tool arguments (as received over JSON-RPC)
 * @param {{root: string, index: object}} ctx
 * @returns {Promise<string>}
 */
export async function callTool(name, args, ctx) {
  const safeArgs = args || {};

  switch (name) {
    case 'grasp_search':
      return searchTool(safeArgs, ctx);
    case 'grasp_outline':
      return outlineTool(safeArgs, ctx);
    case 'grasp_read':
      return readTool(safeArgs, ctx);
    case 'grasp_neighbors':
      return neighborsTool(safeArgs, ctx);
    case 'grasp_pack':
      return packTool(safeArgs, ctx);
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// --- grasp_search -----------------------------------------------------

function searchTool(args, ctx) {
  if (typeof args.query !== 'string' || args.query.length === 0) {
    throw new Error('grasp_search requires a non-empty "query" string argument');
  }

  const opts = {};
  if (args.top != null) opts.top = args.top;

  const results = rank(ctx.index, args.query, opts);

  if (results.length === 0) {
    return '(no results)';
  }

  return results.map(formatResultLine).join('\n');
}

/**
 * Render one rank() result as `path:Lstart-Lend [symbol] score`, omitting
 * the `[symbol]` segment entirely when `symbol` is null (SPEC clarification
 * #10) — the same location form the CLI's `ask` command uses.
 */
function formatResultLine(r) {
  const symbolPart = r.symbol ? ` [${r.symbol}]` : '';
  return `${r.file}:L${r.startLine}-${r.endLine}${symbolPart} ${formatScore(r.score)}`;
}

function formatScore(score) {
  return Number.isInteger(score) ? String(score) : score.toFixed(2);
}

// --- grasp_outline ------------------------------------------------------

function outlineTool(args, ctx) {
  if (!args.path) {
    return outlineRepo(ctx.index);
  }

  const relPath = normalizeRelPath(args.path);
  const fileRecord = findFileRecord(ctx.index, relPath);
  if (fileRecord) {
    return outlineFile(fileRecord);
  }

  // Not an exact file match — treat it as a directory subtree.
  return outlineRepo(ctx.index, { dir: relPath });
}

// --- grasp_read -----------------------------------------------------------

async function readTool(args, ctx) {
  if (!args.path) {
    throw new Error('grasp_read requires a "path" argument');
  }

  const relPath = normalizeRelPath(args.path);

  let startLine = args.startLine;
  let endLine = args.endLine;

  if (args.symbol) {
    const fileRecord = findFileRecord(ctx.index, relPath);
    if (!fileRecord) {
      throw new Error(`file not found in index: ${relPath}`);
    }
    const sym = (fileRecord.symbols || []).find((s) => s.name === args.symbol);
    if (!sym) {
      throw new Error(`symbol "${args.symbol}" not found in ${relPath}`);
    }
    startLine = sym.line;
    endLine = sym.endLine;
  }

  const absPath = safeResolve(ctx.root, fromPosix(relPath));
  const text = await readLines(absPath, startLine, endLine);

  if (text === '') {
    return '';
  }

  const firstLine = startLine == null ? 1 : startLine;
  return text
    .split('\n')
    .map((line, i) => `${firstLine + i}: ${line}`)
    .join('\n');
}

// --- grasp_neighbors --------------------------------------------------

function neighborsTool(args, ctx) {
  if (!args.path) {
    throw new Error('grasp_neighbors requires a "path" argument');
  }

  const relPath = normalizeRelPath(args.path);
  const depth = args.depth != null ? args.depth : 1;

  const result = neighbors(ctx.index.graph, relPath, depth);

  const lines = [`imports (${result.imports.length}):`];
  for (const f of result.imports) lines.push(`  ${f}`);
  lines.push(`importedBy (${result.importedBy.length}):`);
  for (const f of result.importedBy) lines.push(`  ${f}`);

  return lines.join('\n');
}

// --- grasp_pack -------------------------------------------------------

async function packTool(args, ctx) {
  if (typeof args.task !== 'string' || args.task.length === 0) {
    throw new Error('grasp_pack requires a non-empty "task" string argument');
  }

  const opts = {};
  if (args.budget != null) opts.budget = args.budget;

  const result = await pack(ctx.index, ctx.root, args.task, opts);
  return result.text;
}

// --- shared helpers -----------------------------------------------------

/**
 * Normalize a user-supplied path argument to the POSIX relative form used as
 * keys throughout the index (strip a leading "./", convert separators).
 */
function normalizeRelPath(p) {
  return toPosix(p).replace(/^\.\//, '');
}

/** Find an indexed file record by exact POSIX relative path match. */
function findFileRecord(index, relPath) {
  return (index.files || []).find((f) => f.path === relPath) || null;
}
