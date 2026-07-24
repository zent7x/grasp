// src/mcp/server.js
//
// MCP (Model Context Protocol) server: newline-delimited JSON-RPC 2.0 over
// stdio, exposing grasp's five tools (search/outline/read/neighbors/pack —
// see mcp/tools.js) to any MCP-speaking client (Claude Code, Cursor, Codex,
// etc). One JSON object per line in both directions; each response is
// written as `JSON.stringify(msg) + "\n"`.
//
// Requests (messages carrying an `id`) get a matching JSON-RPC response
// line. Notifications (no `id`, e.g. `notifications/initialized`) never get
// a reply, regardless of method. This file never lets an error escape to the
// top level — a bad JSON line, an unknown method, or a tool throwing are all
// turned into a JSON-RPC error response instead of crashing the process.
// Only valid JSON-RPC lines are ever written to stdout; diagnostics go to
// stderr.

import { createInterface } from 'node:readline';
import path from 'node:path';
import { loadIndex } from '../store.js';
import { buildIndex } from '../index-build.js';
import { TOOLS, callTool } from './tools.js';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'grasp', version: '0.1.0' };

/**
 * Start the MCP server: ensure an index exists for the target repo (loading
 * the persisted one if present, otherwise building — and persisting — a
 * fresh one), then serve newline-delimited JSON-RPC 2.0 requests over stdio
 * until the input stream ends.
 *
 * @param {object} [opts]
 * @param {string} [opts.root] - repo root to serve (default: process.cwd()).
 * @param {NodeJS.ReadableStream} [opts.input] - request stream (default: process.stdin).
 * @param {NodeJS.WritableStream} [opts.output] - response stream (default: process.stdout).
 * @returns {Promise<void>} resolves once the input stream closes (e.g. the client disconnects).
 */
export async function startServer(opts = {}) {
  const root = path.resolve(opts.root || process.cwd());
  const input = opts.input || process.stdin;
  const output = opts.output || process.stdout;

  // ctx is shared, mutable state handed to every tool call. It is prepared
  // once at startup, then refreshed lazily at each tools/call boundary so an
  // external `grasp index` becomes visible without restarting the server.
  const ctx = { root, index: null };

  try {
    const existing = await loadIndex(root);
    ctx.index = existing || (await buildIndex(root));
  } catch (err) {
    // Don't let a bad initial index crash the whole server: log to stderr
    // (stdout is reserved for JSON-RPC responses) and keep serving.
    // `initialize` / `tools/list` / `ping` still work; any `tools/call` will
    // fail per-request with a JSON-RPC error until the underlying repo/index
    // problem is fixed.
    logError('failed to prepare index', err);
  }

  const rl = createInterface({ input, terminal: false });
  let closing = false;
  let outputUsable = true;

  const closeInput = () => {
    if (closing) return;
    closing = true;
    rl.close();
  };

  let inputErrorHandled = false;
  const handleInputError = (err) => {
    if (inputErrorHandled) return;
    inputErrorHandled = true;
    logError('input stream error', err);
    closeInput();
  };

  const handleOutputError = (err) => {
    if (!outputUsable) return;
    outputUsable = false;
    // EPIPE is the normal failure mode when an MCP client disconnects before
    // reading a response; other errors are useful diagnostics.
    if (err?.code !== 'EPIPE') logError('output stream error', err);
    closeInput();
  };

  // Stream errors are EventEmitter errors, not promise rejections. Without
  // listeners they escape to the process even though request handling below
  // is wrapped in try/catch.
  output.on('error', handleOutputError);
  output.on('close', () => {
    outputUsable = false;
    closeInput();
  });
  // Listen on both streams: readline currently forwards input errors to its
  // Interface, while the direct input listener also covers stream variants
  // that do not forward them. The guard prevents duplicate handling.
  input.on('error', handleInputError);
  rl.on('error', handleInputError);

  const reply = (msg) => {
    if (!outputUsable) return;
    send(output, msg, handleOutputError);
  };

  rl.on('line', (line) => {
    handleLine(line, ctx, reply).catch((err) => {
      // handleLine already converts everything meaningful into a JSON-RPC
      // response; this is a last-resort net so a truly unexpected failure
      // still can't crash the process or corrupt stdout.
      logError('unhandled error handling request', err);
    });
  });

  return new Promise((resolve) => {
    rl.on('close', () => {
      closing = true;
      resolve();
    });
  });
}

/** Parse and dispatch a single newline-delimited JSON-RPC message. */
async function handleLine(line, ctx, reply) {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch (err) {
    logError('parse error', err);
    reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }

  if (!isRecord(msg) || msg.jsonrpc !== '2.0') {
    reply(invalidRequest());
    return;
  }

  const hasMethod = hasOwn(msg, 'method');
  // MCP is bidirectional JSON-RPC. This server currently sends no requests,
  // so a response is unsolicited, but it is still a response and must never
  // itself receive a response (which could create an error loop).
  if (!hasMethod && (hasOwn(msg, 'result') || hasOwn(msg, 'error'))) return;

  if (!hasMethod || typeof msg.method !== 'string') {
    reply(invalidRequest());
    return;
  }

  const hasId = Object.prototype.hasOwnProperty.call(msg, 'id');

  if (hasId && !isValidId(msg.id)) {
    reply(invalidRequest());
    return;
  }

  // Valid notifications never get a reply (e.g. clients send
  // `notifications/initialized` after `initialize`).
  if (!hasId) return;

  const { id, method, params } = msg;

  const paramsError = validateParams(method, params, hasOwn(msg, 'params'));
  if (paramsError) {
    reply({
      jsonrpc: '2.0',
      id,
      error: { code: -32602, message: paramsError },
    });
    return;
  }

  try {
    const result = await dispatch(method, params, ctx);
    reply({ jsonrpc: '2.0', id, result });
  } catch (err) {
    reply({
      jsonrpc: '2.0',
      id,
      error: {
        code: typeof err?.code === 'number' ? err.code : -32603,
        message: err?.message || String(err),
      },
    });
  }
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidId(id) {
  return id === null || typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
}

function invalidRequest() {
  return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
}

/** Validate the object-shaped params used by grasp's four request methods. */
function validateParams(method, params, hasParams) {
  if (!['initialize', 'ping', 'tools/list', 'tools/call'].includes(method)) return null;

  if (method === 'tools/call' && !hasParams) {
    return 'Invalid params: tools/call requires a params object';
  }
  if (hasParams && !isRecord(params)) {
    return `Invalid params for ${method}: expected an object`;
  }

  if (method === 'tools/call') {
    if (typeof params.name !== 'string') {
      return 'Invalid params: tools/call requires a string "name"';
    }
    if (hasOwn(params, 'arguments') && !isRecord(params.arguments)) {
      return 'Invalid params: tools/call "arguments" must be an object';
    }
  }

  return null;
}

/** Route one JSON-RPC method to its result, or throw a JSON-RPC-flavored error. */
async function dispatch(method, params, ctx) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
      };

    case 'ping':
      return {};

    case 'tools/list':
      return {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      };

    case 'tools/call': {
      const latest = await loadIndex(ctx.root);
      if (latest) ctx.index = latest;
      const { name, arguments: args } = params || {};
      const text = await callTool(name, args, ctx);
      return { content: [{ type: 'text', text }] };
    }

    default: {
      const err = new Error(`Method not found: ${method}`);
      err.code = -32601;
      throw err;
    }
  }
}

function send(output, msg, onError) {
  try {
    output.write(JSON.stringify(msg) + '\n');
  } catch (err) {
    onError(err);
  }
}

function logError(message, err) {
  process.stderr.write(`grasp mcp: ${message}: ${err?.stack || err?.message || String(err)}\n`);
}
