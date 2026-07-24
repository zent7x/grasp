// test/integration.test.js
//
// End-to-end coverage across the whole grasp pipeline, tying together modules
// that the other (per-file) test suites exercise in isolation:
//
//   index-build.js  -> the full walk -> extract -> chunk -> bm25 -> graph
//                       pipeline, run against fixtures/sample (noSave:true)
//                       per SPEC.md's fixture guarantees.
//   rank.js         -> the "login" query must rank a chunk from src/auth.js
//                       first (SPEC.md's core ranking guarantee).
//   pack.js         -> a small token budget must be honored exactly.
//   cli.js          -> `grasp index` + `grasp ask` wired together end-to-end
//                       (index -> store -> query -> rank -> CLI formatting),
//                       run in-process against a temp copy of the fixture.
//
// A separate hermetic temp repo (fs.mkdtemp) proves the gitignore/binary
// "SKIP" behavior end-to-end through buildIndex itself (not just walkRepo in
// isolation), without ever depending on the fixture actually being tracked by
// git — grasp's own gitignore.js parses the .gitignore file directly.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildIndex } from '../src/index-build.js';
import { rank } from '../src/rank.js';
import { pack } from '../src/pack.js';
import { run } from '../src/cli.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, '..', 'fixtures', 'sample');

const EXPECTED_FIXTURE_FILES = [
  '.gitignore',
  'README.md',
  'scripts/migrate.py',
  'src/api/routes.js',
  'src/auth.js',
  'src/db.js',
  'src/util.js',
].sort();

// ---------------------------------------------------------------------------
// buildIndex(fixtures/sample, { noSave: true })
// ---------------------------------------------------------------------------

describe('buildIndex on fixtures/sample (noSave: true)', () => {
  test('fileCount/files exclude the gitignored dir and the binary file', async () => {
    const index = await buildIndex(FIXTURE_ROOT, { noSave: true });
    const paths = index.files.map((f) => f.path).sort();

    assert.deepEqual(paths, EXPECTED_FIXTURE_FILES);
    assert.equal(index.fileCount, EXPECTED_FIXTURE_FILES.length);

    assert.ok(!paths.includes('ignored/secret.txt'), 'gitignored file must be excluded');
    assert.ok(!paths.some((p) => p.startsWith('ignored/')), 'nothing under ignored/ may appear');
    assert.ok(!paths.includes('assets/logo.bin'), 'binary file must be excluded');
  });

  test('noSave:true never writes .grasp/index.json to the real fixture', async () => {
    await buildIndex(FIXTURE_ROOT, { noSave: true });
    await assert.rejects(
      () => fsp.access(path.join(FIXTURE_ROOT, '.grasp', 'index.json')),
      (err) => err && err.code === 'ENOENT',
      'noSave:true must not persist an index file'
    );
  });

  test('chunkCount, bm25.N, and bm25.chunkMeta all agree with files[].chunks, and chunk ids follow "<fileIndex>:<chunkIndex>"', async () => {
    const index = await buildIndex(FIXTURE_ROOT, { noSave: true });

    const totalChunks = index.files.reduce((n, f) => n + f.chunks.length, 0);
    assert.equal(index.chunkCount, totalChunks);
    assert.equal(index.bm25.N, totalChunks);
    assert.equal(Object.keys(index.bm25.chunkMeta).length, totalChunks);

    // SPEC clarification #1: chunkId is the one join key, byte-identical
    // across files[].chunks[].id and bm25.chunkMeta keys.
    for (let fi = 0; fi < index.files.length; fi++) {
      const file = index.files[fi];
      for (let ci = 0; ci < file.chunks.length; ci++) {
        const chunk = file.chunks[ci];
        assert.equal(chunk.id, `${fi}:${ci}`);

        const meta = index.bm25.chunkMeta[chunk.id];
        assert.ok(meta, `bm25.chunkMeta must contain an entry for ${chunk.id}`);
        assert.equal(meta.file, file.path);
        assert.equal(meta.startLine, chunk.startLine);
        assert.equal(meta.endLine, chunk.endLine);
        assert.equal(meta.symbol, chunk.symbol);
      }
    }
  });

  test('auth.js symbols include login/logout/TOKEN_TTL; migrate.py symbols include migrate, imports include os', async () => {
    const index = await buildIndex(FIXTURE_ROOT, { noSave: true });

    const auth = index.files.find((f) => f.path === 'src/auth.js');
    assert.ok(auth, 'src/auth.js must be indexed');
    const authNames = auth.symbols.map((s) => s.name);
    assert.ok(authNames.includes('login'));
    assert.ok(authNames.includes('logout'));
    assert.ok(authNames.includes('TOKEN_TTL'));

    const migrate = index.files.find((f) => f.path === 'scripts/migrate.py');
    assert.ok(migrate, 'scripts/migrate.py must be indexed');
    assert.ok(migrate.symbols.some((s) => s.name === 'migrate'));
    assert.ok(migrate.imports.includes('os'));
  });

  test('routes.js imports resolve to auth.js + db.js in both directions of the graph', async () => {
    const index = await buildIndex(FIXTURE_ROOT, { noSave: true });

    const routes = index.files.find((f) => f.path === 'src/api/routes.js');
    assert.ok(routes, 'src/api/routes.js must be indexed');
    assert.ok(routes.imports.includes('../auth.js'));
    assert.ok(routes.imports.includes('../db.js'));

    const outEdges = index.graph.out['src/api/routes.js'] || [];
    assert.ok(outEdges.includes('src/auth.js'), 'graph.out[routes.js] must resolve to src/auth.js');
    assert.ok(outEdges.includes('src/db.js'), 'graph.out[routes.js] must resolve to src/db.js');

    assert.ok(
      (index.graph.in['src/auth.js'] || []).includes('src/api/routes.js'),
      'graph.in[auth.js] must include routes.js'
    );
    assert.ok(
      (index.graph.in['src/db.js'] || []).includes('src/api/routes.js'),
      'graph.in[db.js] must include routes.js'
    );
  });
});

// ---------------------------------------------------------------------------
// rank(index, "login") — SPEC.md's core ranking guarantee
// ---------------------------------------------------------------------------

describe('rank(index, "login") on fixtures/sample', () => {
  test('the top-ranked chunk is from src/auth.js (its "login" symbol boost outranks routes.js\'s higher raw tf)', async () => {
    const index = await buildIndex(FIXTURE_ROOT, { noSave: true });
    const results = rank(index, 'login');

    assert.ok(results.length > 0, 'rank must return at least one result for "login"');
    assert.equal(results[0].file, 'src/auth.js');
    assert.equal(results[0].symbol, 'login');
    assert.ok(
      results[0].reasons.some((r) => r === 'symbol:login'),
      `expected a "symbol:login" reason, got: ${JSON.stringify(results[0].reasons)}`
    );
  });

  test('results are sorted descending by score, and never include a chunk with no query-term overlap', async () => {
    const index = await buildIndex(FIXTURE_ROOT, { noSave: true });
    const results = rank(index, 'login');

    for (let i = 1; i < results.length; i++) {
      assert.ok(
        results[i - 1].score >= results[i].score,
        `results must be sorted desc by score at index ${i}`
      );
    }

    // Every returned file must be one of the files that actually mentions
    // "login" or is graph-adjacent to one that does (per SPEC clarification
    // #5 boosts never introduce chunks with zero bm25 overlap — but every
    // chunk here should trace back to at least one of these known carriers).
    const plausibleFiles = new Set(['src/auth.js', 'src/api/routes.js', 'README.md']);
    for (const r of results) {
      assert.ok(plausibleFiles.has(r.file), `unexpected file in "login" results: ${r.file}`);
    }
  });
});

// ---------------------------------------------------------------------------
// pack(index, root, task, { budget }) — small budget must be respected
// ---------------------------------------------------------------------------

describe('pack respects a small token budget', () => {
  test('pack("login", { budget: 300 }) never exceeds budget and includes the auth.js login chunk', async () => {
    const index = await buildIndex(FIXTURE_ROOT, { noSave: true });
    const budget = 300;
    const result = await pack(index, FIXTURE_ROOT, 'login', { budget });

    assert.ok(result.tokens <= budget, `tokens (${result.tokens}) must not exceed budget (${budget})`);
    assert.ok(result.included.length > 0, 'a 300-token budget should fit at least one chunk');
    assert.ok(
      result.included.some((c) => c.file === 'src/auth.js' && c.startLine === 3 && c.endLine === 9),
      'the top-ranked auth.js login chunk (lines 3-9) should be included under a 300-token budget'
    );

    const summedTokens = result.included.reduce((n, c) => n + c.tokens, 0);
    assert.equal(summedTokens, result.tokens, 'top-level tokens must equal the sum of included chunk tokens');

    assert.ok(result.text.includes('# grasp pack: login'), 'pack text must include the task header');
    assert.ok(result.text.includes('src/auth.js'), 'pack text must reference the included file');
  });

  test('a near-zero budget still returns a well-formed pack (no chunks fit, nothing throws)', async () => {
    const index = await buildIndex(FIXTURE_ROOT, { noSave: true });
    const result = await pack(index, FIXTURE_ROOT, 'login', { budget: 1 });

    assert.ok(result.tokens <= 1);
    assert.deepEqual(result.included, []);
    assert.ok(Array.isArray(result.trimmed));
    assert.ok(result.trimmed.length > 0);
  });
});

// ---------------------------------------------------------------------------
// CLI end-to-end: `grasp index` then `grasp ask "login"` wired together
// against a temp copy of the fixture (index -> store -> query -> rank -> CLI
// formatting), run in-process via cli.js's `run` export.
// ---------------------------------------------------------------------------

describe('CLI `grasp index` + `grasp ask "login"` end-to-end (temp copy of fixture)', () => {
  async function withTempFixtureCopy(fn) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'grasp-integration-'));
    await fsp.cp(FIXTURE_ROOT, dir, { recursive: true });
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      await fn(dir);
    } finally {
      process.chdir(originalCwd);
      await fsp.rm(dir, { recursive: true, force: true });
    }
  }

  function captureConsoleLog() {
    const calls = [];
    const original = console.log;
    console.log = (...args) => calls.push(args.join(' '));
    return {
      calls,
      restore() {
        console.log = original;
      },
    };
  }

  test('`grasp ask "login" --json` top result is from src/auth.js', async () => {
    await withTempFixtureCopy(async (dir) => {
      const indexCapture = captureConsoleLog();
      await run(['index']);
      indexCapture.restore();
      assert.ok(
        indexCapture.calls.some((line) => /^indexed \d+ files, \d+ chunks/.test(line)),
        `expected an "indexed N files, N chunks" line, got: ${JSON.stringify(indexCapture.calls)}`
      );

      const indexFileExists = await fsp
        .access(path.join(dir, '.grasp', 'index.json'))
        .then(() => true)
        .catch(() => false);
      assert.ok(indexFileExists, '`grasp index` must persist .grasp/index.json');

      const askCapture = captureConsoleLog();
      await run(['ask', 'login', '--json']);
      askCapture.restore();

      const parsed = JSON.parse(askCapture.calls.join('\n'));
      assert.ok(Array.isArray(parsed) && parsed.length > 0);
      assert.equal(parsed[0].file, 'src/auth.js');
      assert.equal(parsed[0].symbol, 'login');
    });
  });

  test('`grasp ask "login"` plain-text top line names src/auth.js at lines 3-9', async () => {
    await withTempFixtureCopy(async () => {
      const indexCapture = captureConsoleLog();
      await run(['index']);
      indexCapture.restore();

      const askCapture = captureConsoleLog();
      await run(['ask', 'login']);
      askCapture.restore();

      assert.ok(askCapture.calls.length > 0, '`grasp ask` must print at least one result line');
      assert.ok(
        askCapture.calls[0].startsWith('src/auth.js:L3-9'),
        `unexpected top result line: ${askCapture.calls[0]}`
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Hermetic temp repo (fs.mkdtemp) — proves the gitignore/binary "SKIP"
// behavior end-to-end through buildIndex itself, independent of git tracking.
// ---------------------------------------------------------------------------

describe('buildIndex SKIP behavior on a hermetic temp repo (no git dependency)', () => {
  async function buildTempRepo() {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'grasp-integration-hermetic-'));

    async function write(relPath, content) {
      const abs = path.join(root, ...relPath.split('/'));
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, content);
    }

    await write('.gitignore', 'ignored/\n*.log\n');
    await write(
      'src/greet.js',
      "// greet.js — a tiny hermetic-repo fixture, unrelated to fixtures/sample.\nexport function greet(name) {\n  return 'hello ' + name;\n}\n"
    );
    await write('ignored/secret.txt', 'top secret, must never be indexed\n');
    await write('debug.log', 'log noise, must never be indexed\n');

    // Binary via NUL-byte sniffing (extension not on walk.js's blocklist).
    await fsp.writeFile(path.join(root, 'blob.data'), Buffer.from([0x00, 0x01, 0x02, 0x68, 0x69]));

    return root;
  }

  test('buildIndex excludes gitignored and binary files end-to-end, with no leakage into bm25/graph', async () => {
    const root = await buildTempRepo();
    try {
      const index = await buildIndex(root, { noSave: true });
      const paths = index.files.map((f) => f.path);

      assert.ok(paths.includes('.gitignore'));
      assert.ok(paths.includes('src/greet.js'));
      assert.ok(!paths.includes('ignored/secret.txt'), 'gitignored file must be excluded from buildIndex');
      assert.ok(!paths.includes('debug.log'), 'gitignored *.log file must be excluded from buildIndex');
      assert.ok(!paths.includes('blob.data'), 'NUL-byte binary file must be excluded from buildIndex');

      // The excluded files must never surface anywhere downstream either:
      // not as a chunk owner, and not as a symbol/import source.
      for (const meta of Object.values(index.bm25.chunkMeta)) {
        assert.ok(
          !['ignored/secret.txt', 'debug.log', 'blob.data'].includes(meta.file),
          `bm25.chunkMeta must never reference an excluded file, found ${meta.file}`
        );
      }
      assert.ok(!('ignored/secret.txt' in index.graph.out));
      assert.ok(!('debug.log' in index.graph.out));

      const greet = index.files.find((f) => f.path === 'src/greet.js');
      assert.ok(greet.symbols.some((s) => s.name === 'greet'));
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
