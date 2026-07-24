// test/mcp.test.js
//
// Exercises the MCP (Model Context Protocol) transport and tool catalog
// described in SPEC.md's "MCP protocol" section: src/mcp/server.js
// (startServer — newline-delimited JSON-RPC 2.0 over stdio) and
// src/mcp/tools.js (TOOLS catalog + callTool dispatch).
//
// startServer already accepts injectable `input`/`output` streams, so this
// wires the REAL server straight to a pair of in-memory PassThrough streams
// standing in for stdin/stdout — the exact newline-delimited-JSON-RPC wire
// protocol the spec describes, minus forking a second OS process.
//
// Because startServer persists a freshly-built index to
// `<root>/.grasp/index.json` when none exists yet, every server instance here
// runs against either (a) a throwaway copy of fixtures/sample made with
// fs.mkdtemp (so the checked-in fixture is never mutated and never gains a
// stray .grasp/ directory) or (b) a fully hermetic temp repo built from
// scratch, so gitignore/walk-skip behavior is proven independent of git
// tracking state.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, rm, cp, symlink } from 'node:fs/promises';
import { PassThrough, Writable } from 'node:stream';

import { startServer } from '../src/mcp/server.js';
import { TOOLS } from '../src/mcp/tools.js';
import { buildIndex } from '../src/index-build.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, '..', 'fixtures', 'sample');
const BIN_PATH = path.join(__dirname, '..', 'bin', 'grasp.js');

// ---------------------------------------------------------------------------
// Harness: wire the real startServer to in-memory stdin/stdout stand-ins and
// give tests a request/response API over the newline-delimited JSON-RPC wire.
// ---------------------------------------------------------------------------

function makeHarness(root) {
  const input = new PassThrough();
  const output = new PassThrough();

  const pending = [];
  const waiters = [];
  let buf = '';

  output.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line); // throws (failing the test) if a non-JSON line ever hits stdout
      if (waiters.length > 0) {
        waiters.shift()(msg);
      } else {
        pending.push(msg);
      }
    }
  });

  function nextMessage(timeoutMs = 5000) {
    if (pending.length > 0) return Promise.resolve(pending.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('timed out waiting for an MCP response line'));
      }, timeoutMs);
      waiters.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  }

  function send(msg) {
    input.write(JSON.stringify(msg) + '\n');
  }

  function sendRawLine(line) {
    input.write(line.endsWith('\n') ? line : `${line}\n`);
  }

  const serverDone = startServer({ root, input, output });

  async function close() {
    input.end();
    await serverDone;
  }

  return { send, sendRawLine, nextMessage, close };
}

async function makeTempFixtureCopy() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grasp-mcp-fixture-'));
  await cp(FIXTURE_ROOT, dir, { recursive: true });
  return dir;
}

function withTimeout(promise, label, timeoutMs = 5000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function nextJsonLine(stream, timeoutMs = 5000) {
  return withTimeout(
    new Promise((resolve, reject) => {
      let buf = '';
      const onData = (chunk) => {
        buf += chunk.toString('utf8');
        const newline = buf.indexOf('\n');
        if (newline === -1) return;
        cleanup();
        try {
          resolve(JSON.parse(buf.slice(0, newline)));
        } catch (err) {
          reject(err);
        }
      };
      const onError = (err) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        stream.off('data', onData);
        stream.off('error', onError);
      };
      stream.on('data', onData);
      stream.on('error', onError);
    }),
    'a JSON response line',
    timeoutMs
  );
}

// ---------------------------------------------------------------------------
// Core protocol + tool dispatch, against a throwaway copy of fixtures/sample.
// One shared server session for the whole group (mirrors a real MCP client:
// one connection, many sequential requests) — node:test runs top-level tests
// within a file sequentially, so message ordering across `test()`s here is
// deterministic.
// ---------------------------------------------------------------------------

describe('MCP server — protocol + tools against fixtures/sample (temp copy)', () => {
  let root;
  let harness;
  let nextId = 1;

  before(async () => {
    root = await makeTempFixtureCopy();
    harness = makeHarness(root);
  });

  after(async () => {
    await harness.close();
    await rm(root, { recursive: true, force: true });
  });

  function call(method, params) {
    const id = nextId++;
    harness.send({ jsonrpc: '2.0', id, method, params });
    return harness.nextMessage().then((msg) => {
      assert.equal(msg.id, id, `response id must echo the request id for method "${method}"`);
      return msg;
    });
  }

  test('initialize returns the exact protocolVersion/serverInfo/capabilities shape', async () => {
    const msg = await call('initialize', {});
    assert.equal(msg.jsonrpc, '2.0');
    assert.equal(msg.error, undefined);
    assert.deepEqual(msg.result, {
      protocolVersion: '2024-11-05',
      serverInfo: { name: 'grasp', version: '0.1.0' },
      capabilities: { tools: {} },
    });
  });

  test('a notification (no id) never gets a reply, even for a recognized method', async () => {
    // notifications/initialized carries no `id`; per the MCP protocol section
    // (and server.js's explicit hasId check) it must produce zero response
    // lines. Prove it by immediately following with an id-bearing `ping` and
    // asserting the very next line on the wire is THAT response, not a stray
    // reply to the notification.
    harness.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    const pingId = nextId++;
    harness.send({ jsonrpc: '2.0', id: pingId, method: 'ping' });

    const msg = await harness.nextMessage();
    assert.equal(msg.id, pingId, 'the notification must not have produced a response line ahead of the ping reply');
    assert.deepEqual(msg.result, {});
  });

  test('tools/list returns exactly the real TOOLS catalog (name, description, inputSchema)', async () => {
    const msg = await call('tools/list');
    assert.equal(msg.error, undefined);
    assert.ok(Array.isArray(msg.result.tools));
    assert.deepEqual(
      msg.result.tools,
      TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      'tools/list must forward the real mcp/tools.js TOOLS catalog verbatim, not a hand-duplicated copy'
    );

    const names = msg.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'grasp_neighbors',
      'grasp_outline',
      'grasp_pack',
      'grasp_read',
      'grasp_search',
    ]);

    for (const tool of msg.result.tools) {
      assert.equal(tool.inputSchema.type, 'object', `${tool.name} inputSchema must be a JSON-Schema object`);
    }
  });

  test('an unknown method produces a JSON-RPC -32601 error, not a crash', async () => {
    const msg = await call('nonexistent/method');
    assert.equal(msg.result, undefined);
    assert.equal(msg.error.code, -32601);
  });

  test('a malformed JSON line on stdin produces a -32700 parse error with id null (and does not kill the server)', async () => {
    harness.sendRawLine('{ this is not valid json');
    const parseErrMsg = await harness.nextMessage();
    assert.equal(parseErrMsg.id, null);
    assert.equal(parseErrMsg.error.code, -32700);

    // The server must still be alive and answering afterwards.
    const msg = await call('ping');
    assert.deepEqual(msg.result, {});
  });

  test('invalid JSON-RPC envelopes produce -32600 instead of being accepted or silently dropped', async () => {
    const invalidMessages = [
      {},
      { jsonrpc: '1.0', id: 900, method: 'ping' },
      { jsonrpc: '2.0', id: 901 },
      { jsonrpc: '2.0', id: { invalid: true }, method: 'ping' },
    ];

    for (const invalid of invalidMessages) {
      harness.send(invalid);
      const msg = await harness.nextMessage();
      assert.equal(msg.id, null);
      assert.equal(msg.error.code, -32600);
    }
  });

  test('an inbound JSON-RPC response is ignored rather than answered as an unknown request', async () => {
    harness.send({ jsonrpc: '2.0', id: 902, result: {} });
    const pingId = nextId++;
    harness.send({ jsonrpc: '2.0', id: pingId, method: 'ping' });

    const msg = await harness.nextMessage();
    assert.equal(msg.id, pingId);
    assert.deepEqual(msg.result, {});
  });

  test('malformed params for known methods produce -32602 without executing a tool', async () => {
    const badParams = await call('tools/call', []);
    assert.equal(badParams.error.code, -32602);

    const missingName = await call('tools/call', {});
    assert.equal(missingName.error.code, -32602);

    const badArguments = await call('tools/call', {
      name: 'grasp_outline',
      arguments: 'not-an-object',
    });
    assert.equal(badArguments.error.code, -32602);
  });

  test('grasp_search "login" ranks a chunk from src/auth.js first (SPEC fixture guarantee)', async () => {
    const msg = await call('tools/call', { name: 'grasp_search', arguments: { query: 'login', top: 5 } });
    assert.equal(msg.error, undefined);
    assert.equal(msg.result.content[0].type, 'text');

    const text = msg.result.content[0].text;
    const lines = text.split('\n');
    assert.ok(lines.length > 0 && lines[0] !== '(no results)', 'expected at least one ranked result for "login"');

    // Line form is `path:Lstart-end [symbol] score` — the same single-"L"
    // `formatLoc` form src/cli.js's `ask` command uses (clarification #10).
    assert.match(lines[0], /^src\/auth\.js:L\d+-\d+(?: \[[^\]]+\])? -?\d+(\.\d+)?$/);
    assert.ok(lines[0].startsWith('src/auth.js:'), 'top result must come from src/auth.js');
  });

  test('grasp_read reads the exact login() body by symbol name (safeResolve + readLines, line-numbered)', async () => {
    const msg = await call('tools/call', {
      name: 'grasp_read',
      arguments: { path: 'src/auth.js', symbol: 'login' },
    });
    assert.equal(msg.error, undefined);

    const text = msg.result.content[0].text;
    // login starts at line 3 and (per SPEC's endLine best-effort rule) runs
    // up to logout.line - 1 == 9, i.e. through the blank line before logout.
    const expected = [
      '3: export function login(user) {',
      "4:   if (!user) {",
      "5:     throw new Error('user is required');",
      '6:   }',
      "7:   return { user, token: 'tok_' + user, expiresIn: TOKEN_TTL };",
      '8: }',
      '9: ',
    ].join('\n');
    assert.equal(text, expected);
  });

  test('grasp_read rejects a path-traversal attempt as a JSON-RPC error instead of leaking a file outside root', async () => {
    const msg = await call('tools/call', {
      name: 'grasp_read',
      arguments: { path: '../outside.txt' },
    });
    assert.equal(msg.result, undefined);
    assert.ok(msg.error, 'expected a JSON-RPC error for an out-of-root path');
    assert.match(msg.error.message, /path escapes root/);
  });

  test('grasp_read rejects an in-root symlink whose target is outside the repo', async (t) => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'grasp-mcp-outside-'));
    try {
      await writeFile(path.join(outside, 'secret.txt'), 'must not escape\n', 'utf8');
      try {
        await symlink(outside, path.join(root, 'escape-link'));
      } catch (err) {
        if (err?.code === 'EPERM' || err?.code === 'EACCES' || err?.code === 'ENOSYS') {
          t.skip(`symlinks unavailable: ${err.code}`);
          return;
        }
        throw err;
      }

      const msg = await call('tools/call', {
        name: 'grasp_read',
        arguments: { path: 'escape-link/secret.txt' },
      });
      assert.equal(msg.result, undefined);
      assert.equal(msg.error.code, -32603);
      assert.match(msg.error.message, /path escapes root/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('grasp_neighbors reports auth.js is imported by routes.js and imports nothing itself (SPEC fixture guarantee)', async () => {
    const msg = await call('tools/call', {
      name: 'grasp_neighbors',
      arguments: { path: 'src/auth.js' },
    });
    assert.equal(msg.error, undefined);
    const text = msg.result.content[0].text;
    assert.equal(
      text,
      ['imports (0):', 'importedBy (1):', '  src/api/routes.js'].join('\n')
    );
  });

  test('grasp_neighbors reports routes.js imports both auth.js and db.js (SPEC fixture guarantee)', async () => {
    const msg = await call('tools/call', {
      name: 'grasp_neighbors',
      arguments: { path: 'src/api/routes.js', depth: 1 },
    });
    assert.equal(msg.error, undefined);
    const text = msg.result.content[0].text;
    const importsLine = text.split('\n')[0];
    assert.equal(importsLine, 'imports (2):');
    assert.ok(text.includes('  src/auth.js'));
    assert.ok(text.includes('  src/db.js'));
    assert.ok(text.includes('importedBy (0):'), 'nothing in the fixture imports routes.js');
  });

  test('grasp_outline with no path excludes gitignored/binary fixture entries and includes real source files', async () => {
    const msg = await call('tools/call', { name: 'grasp_outline', arguments: {} });
    assert.equal(msg.error, undefined);
    const text = msg.result.content[0].text;

    // walk skips ignored/secret.txt and assets/logo.bin (SPEC fixture
    // guarantee); neither should ever have made it into the index this
    // outline is rendered from.
    assert.ok(!text.includes('secret.txt'));
    assert.ok(!text.includes('logo.bin'));
    assert.ok(!/(^|\n)ignored\//.test(text), 'the ignored/ directory itself must not appear in the outline tree');

    assert.ok(text.includes('auth.js'));
    assert.ok(text.includes('db.js'));
    assert.ok(text.includes('routes.js'));
    assert.ok(text.includes('migrate.py'));
  });

  test('grasp_outline with a file path returns that file\'s symbol list (login/logout/TOKEN_TTL)', async () => {
    const msg = await call('tools/call', { name: 'grasp_outline', arguments: { path: 'src/auth.js' } });
    assert.equal(msg.error, undefined);
    const text = msg.result.content[0].text;
    const lines = text.split('\n');
    assert.equal(lines[0], 'src/auth.js');
    assert.ok(lines.some((l) => /function login\s+\(L3-L9\)/.test(l)));
    assert.ok(lines.some((l) => /function logout\s+\(L10-L\d+\)/.test(l)));
    assert.ok(lines.some((l) => /const TOKEN_TTL\s+\(L14-L\d+\)/.test(l)));
  });

  test('grasp_pack respects a small token budget end to end over the wire (SPEC test expectation)', async () => {
    const budget = 300;
    const msg = await call('tools/call', {
      name: 'grasp_pack',
      arguments: { task: 'login', budget },
    });
    assert.equal(msg.error, undefined);
    const text = msg.result.content[0].text;

    assert.ok(text.startsWith('# grasp pack: login'));

    const summaryMatch = text.match(/~(\d+) tokens \(budget (\d+)\)/);
    assert.ok(summaryMatch, `expected a "~N tokens (budget M)" summary line, got:\n${text}`);
    const [, usedStr, budgetStr] = summaryMatch;
    assert.equal(Number(budgetStr), budget);
    assert.ok(Number(usedStr) <= budget, `packed tokens (${usedStr}) must never exceed the budget (${budget})`);
  });

  test('tools/call with an unrecognized tool name produces a JSON-RPC error, not a crash', async () => {
    const msg = await call('tools/call', { name: 'grasp_does_not_exist', arguments: {} });
    assert.equal(msg.result, undefined);
    assert.ok(msg.error);
    assert.match(msg.error.message, /unknown tool/);

    // The server must still be alive afterwards.
    const pingMsg = await call('ping');
    assert.deepEqual(pingMsg.result, {});
  });
});

// ---------------------------------------------------------------------------
// Hermetic temp repo — proves the MCP server's own index build (walkRepo +
// gitignore.js, triggered by startServer when no .grasp/index.json exists
// yet) actually excludes gitignored content end to end, independent of git
// ever tracking anything in this directory.
// ---------------------------------------------------------------------------

describe('MCP server — index build respects .gitignore in a hermetic temp repo', () => {
  let root;
  let harness;

  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'grasp-mcp-hermetic-'));
    await writeFile(path.join(root, '.gitignore'), 'ignored_stuff/\n', 'utf8');

    await mkdir(path.join(root, 'ignored_stuff'), { recursive: true });
    await writeFile(
      path.join(root, 'ignored_stuff', 'secretLogin.js'),
      "export function secretLogin() { return 'login'; }\n",
      'utf8'
    );

    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'keep.js'), 'export function login() { return true; }\n', 'utf8');

    harness = makeHarness(root);
  });

  after(async () => {
    await harness.close();
    await rm(root, { recursive: true, force: true });
  });

  function call(id, method, params) {
    harness.send({ jsonrpc: '2.0', id, method, params });
    return harness.nextMessage();
  }

  test('grasp_outline never lists the gitignored directory or its file', async () => {
    const msg = await call(1, 'tools/call', { name: 'grasp_outline', arguments: {} });
    const text = msg.result.content[0].text;

    assert.ok(text.includes('keep.js'), 'the real, non-ignored source file must be indexed');
    assert.ok(!text.includes('secretLogin'), 'the gitignored file name must never surface');
    assert.ok(!/(^|\n)ignored_stuff\//.test(text), 'the gitignored directory must never surface in the outline tree');
  });

  test('grasp_search never returns a result from inside the gitignored directory', async () => {
    const msg = await call(2, 'tools/call', { name: 'grasp_search', arguments: { query: 'login', top: 20 } });
    const text = msg.result.content[0].text;

    assert.ok(!text.includes('ignored_stuff'), 'a gitignored file must never be searchable, even if git never tracked it');
    assert.ok(text.includes('src/keep.js'), 'the real source file containing "login" must be found');
  });
});

test('spawned `grasp serve` speaks JSON-RPC over stdio and exits cleanly on EOF', async () => {
  const root = await makeTempFixtureCopy();
  try {
    const requests = [
      {
        jsonrpc: '2.0',
        id: 'init',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'grasp-test', version: '0.0.0' },
        },
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 'list', method: 'tools/list' },
      {
        jsonrpc: '2.0',
        id: 'call',
        method: 'tools/call',
        params: { name: 'grasp_search', arguments: { query: 'login', top: 1 } },
      },
    ];

    const child = spawnSync(process.execPath, [BIN_PATH, 'serve'], {
      cwd: root,
      input: requests.map((msg) => JSON.stringify(msg)).join('\n') + '\n',
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
    });

    assert.ifError(child.error);
    assert.equal(child.signal, null);
    assert.equal(child.status, 0, child.stderr);

    const lines = child.stdout.split('\n').filter((line) => line.length > 0);
    assert.equal(lines.length, 3, `unexpected stdout:\n${child.stdout}`);
    const responses = new Map(lines.map((line) => {
      const msg = JSON.parse(line); // every stdout line must be a JSON message
      assert.equal(msg.jsonrpc, '2.0');
      return [msg.id, msg];
    }));

    assert.equal(responses.get('init').result.protocolVersion, '2024-11-05');
    assert.equal(responses.get('list').result.tools.length, 5);
    assert.match(responses.get('call').result.content[0].text, /^src\/auth\.js:/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('startServer handles an output EPIPE without an uncaught stream error', async () => {
  const root = await makeTempFixtureCopy();
  const input = new PassThrough();
  let writes = 0;
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      writes += 1;
      const err = new Error('synthetic EPIPE');
      err.code = 'EPIPE';
      callback(err);
    },
  });

  try {
    const done = startServer({ root, input, output });
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n');
    await withTimeout(done, 'server shutdown after output EPIPE');
    assert.equal(writes, 1);
  } finally {
    input.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test('startServer handles an error emitted by the actual input stream', async () => {
  const root = await makeTempFixtureCopy();
  const input = new PassThrough();
  const output = new PassThrough();

  try {
    const responsePromise = nextJsonLine(output);
    const done = startServer({ root, input, output });
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n');
    assert.deepEqual((await responsePromise).result, {});

    input.destroy(new Error('synthetic stdin failure'));
    await withTimeout(done, 'server shutdown after input error');
  } finally {
    input.destroy();
    output.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test('tools/call lazily reloads an index rebuilt while the server is running', async () => {
  const root = await makeTempFixtureCopy();
  const harness = makeHarness(root);
  try {
    harness.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    assert.deepEqual((await harness.nextMessage()).result, {});

    await writeFile(path.join(root, 'fresh.js'), 'export function freshlyIndexed() {}\n', 'utf8');
    await buildIndex(root);

    harness.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'grasp_outline', arguments: {} },
    });
    const msg = await harness.nextMessage();
    assert.match(msg.result.content[0].text, /(^|\n)fresh\.js/);
  } finally {
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
});
