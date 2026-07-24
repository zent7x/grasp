// test/cli.test.js
//
// End-to-end tests for the `grasp` CLI (bin/grasp.js -> src/cli.js), spawned
// as a real child process (not imported) so we exercise argv parsing, exit
// codes, and stdout/stderr routing exactly as a human or agent shelling out
// to `grasp` would see them.
//
// All repo-shaped tests run against a fresh temp copy of fixtures/sample
// (never the fixture dir itself, since `index` writes a .grasp/ directory)
// made with fs.cp + fs.mkdtemp, so nothing here depends on git or mutates
// the checked-in fixture. Every expected value below (file/chunk counts,
// symbol names+kinds+line ranges, ranked order, packed token counts, outline
// text) was captured by actually running the pipeline against
// fixtures/sample rather than hand-derived, so a real regression in any
// sibling module (lang.js, symbols.js, rank.js, pack.js, outline.js, ...)
// will surface here as a CLI-level output mismatch.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { promises as fsp } from 'node:fs';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, '..', 'fixtures', 'sample');
const BIN_PATH = path.join(__dirname, '..', 'bin', 'grasp.js');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Spawn `node bin/grasp.js <args...>` with the given cwd; never throws on a
 * non-zero exit (the CLI's own error handling is part of what we're testing).
 * @returns {{ code: number, stdout: string, stderr: string }}
 */
function runCli(args, cwd) {
  const result = spawnSync(process.execPath, [BIN_PATH, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
  });
  if (result.error) {
    throw result.error;
  }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Copy fixtures/sample into a fresh temp directory. */
async function makeTempRepo(prefix = 'grasp-cli-test-') {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  await fsp.cp(FIXTURE_ROOT, dir, { recursive: true });
  return dir;
}

async function rmDir(dir) {
  if (dir) await fsp.rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Shared indexed fixture copy, built once via the real CLI, reused by every
// read-only query test below (ask/pack/outline/stats never mutate the index).
// ---------------------------------------------------------------------------

let QUERY_REPO;
let INDEX_JSON;

before(async () => {
  QUERY_REPO = await makeTempRepo('grasp-cli-query-repo-');
  const result = runCli(['index'], QUERY_REPO);
  assert.equal(result.code, 0, `setup: \`grasp index\` must succeed, got stderr: ${result.stderr}`);

  const raw = await fsp.readFile(path.join(QUERY_REPO, '.grasp', 'index.json'), 'utf8');
  INDEX_JSON = JSON.parse(raw);
});

after(async () => {
  await rmDir(QUERY_REPO);
});

// ---------------------------------------------------------------------------
// grasp index
// ---------------------------------------------------------------------------

test('index: builds .grasp/index.json in a fresh repo copy, exit 0, correct summary line', async () => {
  const repo = await makeTempRepo('grasp-cli-index-basic-');
  try {
    const { code, stdout, stderr } = runCli(['index'], repo);
    assert.equal(code, 0, `expected exit 0, got stderr: ${stderr}`);
    // Fully deterministic for fixtures/sample (verified against the real
    // pipeline): 7 eligible files, 20 chunks.
    assert.equal(stdout.trim(), 'indexed 7 files, 20 chunks → .grasp/index.json');

    const indexPath = path.join(repo, '.grasp', 'index.json');
    const raw = await fsp.readFile(indexPath, 'utf8');
    const index = JSON.parse(raw);

    assert.equal(index.version, 1);
    assert.equal(index.fileCount, 7);
    assert.equal(index.chunkCount, 20);
    // Cross-check the persisted summary fields against the actual per-file
    // chunk arrays rather than trusting them blindly.
    const actualFileCount = index.files.length;
    const actualChunkCount = index.files.reduce((sum, f) => sum + f.chunks.length, 0);
    assert.equal(index.fileCount, actualFileCount);
    assert.equal(index.chunkCount, actualChunkCount);

    // root must be an absolute path resolving to the repo we indexed (compare
    // via realpath so /tmp vs /private/tmp-style OS symlink normalization
    // can never cause a false failure).
    const realRepo = await fsp.realpath(repo);
    assert.equal(path.resolve(index.root), realRepo);

    // Gitignored + binary fixture entries must never appear in the index.
    const paths = index.files.map((f) => f.path).sort();
    assert.deepEqual(paths, [
      '.gitignore',
      'README.md',
      'scripts/migrate.py',
      'src/api/routes.js',
      'src/auth.js',
      'src/db.js',
      'src/util.js',
    ]);
    assert.ok(!paths.includes('ignored/secret.txt'));
    assert.ok(!paths.includes('assets/logo.bin'));
  } finally {
    await rmDir(repo);
  }
});

test('index: auth.js symbols/routes.js imports/graph edges match SPEC\'s fixture guarantees', async () => {
  const auth = INDEX_JSON.files.find((f) => f.path === 'src/auth.js');
  assert.ok(auth, 'src/auth.js must be indexed');
  const names = auth.symbols.map((s) => s.name);
  assert.ok(names.includes('login'));
  assert.ok(names.includes('logout'));
  assert.ok(names.includes('TOKEN_TTL'));

  const routes = INDEX_JSON.files.find((f) => f.path === 'src/api/routes.js');
  assert.ok(routes, 'src/api/routes.js must be indexed');
  assert.ok(routes.imports.includes('../auth.js'));
  assert.ok(routes.imports.includes('../db.js'));

  const outEdges = INDEX_JSON.graph.out['src/api/routes.js'];
  assert.ok(Array.isArray(outEdges));
  assert.ok(outEdges.includes('src/auth.js'));
  assert.ok(outEdges.includes('src/db.js'));

  const py = INDEX_JSON.files.find((f) => f.path === 'scripts/migrate.py');
  assert.ok(py, 'scripts/migrate.py must be indexed');
  assert.ok(py.symbols.some((s) => s.name === 'migrate'));
  assert.ok(py.imports.includes('os'));
});

test('index: accepts an explicit [path] argument and indexes that repo, not the cwd', async () => {
  const repo = await makeTempRepo('grasp-cli-index-path-arg-');
  const otherCwd = __dirname; // any valid cwd distinct from `repo`
  try {
    const { code, stdout } = runCli(['index', repo], otherCwd);
    assert.equal(code, 0);
    assert.equal(stdout.trim(), 'indexed 7 files, 20 chunks → .grasp/index.json');

    // The index must have been written under the target repo, never under
    // the cwd we ran the command from.
    const targetIndex = await fsp.readFile(path.join(repo, '.grasp', 'index.json'), 'utf8').catch(() => null);
    assert.ok(targetIndex, '.grasp/index.json must exist under the given path argument');

    const cwdGraspDir = await fsp
      .stat(path.join(otherCwd, '.grasp'))
      .then(() => true)
      .catch(() => false);
    assert.equal(cwdGraspDir, false, '.grasp must not be created under the unrelated cwd');
  } finally {
    await rmDir(repo);
  }
});

test('index: a nonexistent repo path fails with exit 1 and a directory-read error', () => {
  const bogus = path.join(os.tmpdir(), `grasp-cli-does-not-exist-${Date.now()}`);
  const { code, stderr } = runCli(['index', bogus], __dirname);
  assert.equal(code, 1);
  assert.ok(stderr.includes('grasp:'));
  assert.ok(stderr.includes('cannot read directory'));
  assert.ok(stderr.includes('ENOENT'));
});

// ---------------------------------------------------------------------------
// grasp ask
// ---------------------------------------------------------------------------

test('ask: query "login" ranks a chunk from src/auth.js first (SPEC fixture guarantee)', () => {
  const { code, stdout } = runCli(['ask', 'login'], QUERY_REPO);
  assert.equal(code, 0);

  const lines = stdout.split('\n').filter(Boolean);
  assert.ok(lines.length > 0, 'ask should return at least one ranked result');

  // Exact, verified-against-the-real-pipeline output for this fixture+query.
  assert.deepEqual(lines, [
    'src/auth.js:L3-9 [login] 2.86',
    'src/api/routes.js:L7-10 [db] 1.72',
    'src/api/routes.js:L11-17 [result] 1.72',
    'src/auth.js:L1-2 1.63',
    'src/api/routes.js:L1-5 1.41',
    'README.md:L1-9 0.81',
  ]);
});

test('ask: --json emits a parseable ranked array with src/auth.js first and well-formed reasons', () => {
  const { code, stdout } = runCli(['ask', 'login', '--json'], QUERY_REPO);
  assert.equal(code, 0);

  const results = JSON.parse(stdout);
  assert.ok(Array.isArray(results));
  assert.equal(results.length, 6);

  const top = results[0];
  assert.equal(top.file, 'src/auth.js');
  assert.equal(top.startLine, 3);
  assert.equal(top.endLine, 9);
  assert.equal(top.symbol, 'login');
  assert.equal(typeof top.score, 'number');
  assert.ok(top.score > 0);
  assert.ok(Array.isArray(top.reasons));
  assert.ok(top.reasons.some((r) => r.startsWith('bm25:')));
  assert.ok(top.reasons.includes('symbol:login'));
  assert.ok(top.reasons.includes('graph:routes.js'));

  // A chunk with no symbol (e.g. the auth.js header comment) must report
  // `symbol: null`, not omit the field or use "" (SPEC clarification #10).
  const header = results.find((r) => r.file === 'src/auth.js' && r.startLine === 1);
  assert.ok(header, 'the auth.js header-comment chunk should also be ranked for "login"');
  assert.equal(header.symbol, null);
});

test('ask: --top N truncates the ranked list to N results, in both text and --json form', () => {
  const jsonResult = runCli(['ask', 'login', '--top', '1', '--json'], QUERY_REPO);
  assert.equal(jsonResult.code, 0);
  const parsed = JSON.parse(jsonResult.stdout);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].file, 'src/auth.js');

  const textResult = runCli(['ask', 'login', '--top', '2'], QUERY_REPO);
  assert.equal(textResult.code, 0);
  const lines = textResult.stdout.split('\n').filter(Boolean);
  assert.deepEqual(lines, ['src/auth.js:L3-9 [login] 2.86', 'src/api/routes.js:L7-10 [db] 1.72']);
});

test('ask: a null symbol is rendered without a [symbol] segment on the CLI line', () => {
  const { stdout } = runCli(['ask', 'login', '--top', '4'], QUERY_REPO);
  const lines = stdout.split('\n').filter(Boolean);
  // Result #4 (index 3) is the auth.js header chunk with symbol: null.
  assert.equal(lines[3], 'src/auth.js:L1-2 1.63');
  assert.ok(!lines[3].includes('['));
});

test('ask: missing task argument fails with exit 1 and a usage-style error', () => {
  const { code, stderr } = runCli(['ask'], QUERY_REPO);
  assert.equal(code, 1);
  assert.ok(stderr.includes('grasp:'));
  assert.ok(stderr.includes('ask requires a task'));
});

test('ask: with no prior index, fails with exit 1 and points the user at `grasp index`', async () => {
  const repo = await makeTempRepo('grasp-cli-ask-noindex-');
  try {
    const { code, stderr } = runCli(['ask', 'login'], repo);
    assert.equal(code, 1);
    assert.ok(stderr.includes('No grasp index found'));
    assert.ok(stderr.includes('grasp index'));
  } finally {
    await rmDir(repo);
  }
});

// ---------------------------------------------------------------------------
// grasp pack
// ---------------------------------------------------------------------------

test('pack: default budget produces the full ranked bundle with an accurate token summary', () => {
  const { code, stdout, stderr } = runCli(['pack', 'login'], QUERY_REPO);
  assert.equal(code, 0);

  assert.ok(stdout.startsWith('# grasp pack: login\n'));
  assert.ok(stdout.includes('_6 chunk(s) from 3 file(s), ~222 tokens (budget 8000)_'));

  // Section order follows ranked order: src/auth.js first.
  const sectionHeadings = stdout
    .split('\n')
    .filter((l) => l.startsWith('## '));
  assert.deepEqual(sectionHeadings, ['## src/auth.js', '## src/api/routes.js', '## README.md']);

  // Fenced code blocks are titled `// path:start-end` (no line numbers, no
  // leading "L" — unlike the CLI ask output format).
  assert.ok(stdout.includes('// src/auth.js:1-2'));
  assert.ok(stdout.includes('// src/auth.js:3-9'));
  assert.ok(stdout.includes("export function login(user) {"));

  // Nothing was dropped at this budget, so there is no Trimmed section.
  assert.ok(!stdout.includes('## Trimmed'));

  assert.equal(stderr.trim(), 'packed 222 tokens (budget 8000) — 6 chunk(s) included, 0 file(s) trimmed');
});

test('pack: a small --budget drops lower-ranked chunks/files while keeping tokens <= budget', () => {
  const { code, stdout, stderr } = runCli(['pack', 'login', '--budget', '50'], QUERY_REPO);
  assert.equal(code, 0);

  assert.ok(stdout.includes('_1 chunk(s) from 1 file(s), ~39 tokens (budget 50)_'));
  assert.ok(stdout.includes('## src/auth.js'));
  assert.ok(stdout.includes('// src/auth.js:3-9'));
  assert.ok(!stdout.includes('## src/api/routes.js'));
  assert.ok(!stdout.includes('## README.md'));
  assert.ok(stdout.includes('_(more of src/auth.js omitted — budget exceeded'));
  assert.ok(stdout.includes('## Trimmed (not included)'));
  assert.ok(stdout.includes('- src/api/routes.js — see `grasp outline src/api/routes.js`'));
  assert.ok(stdout.includes('- README.md — see `grasp outline README.md`'));

  const match = stderr.match(/^packed (\d+) tokens \(budget (\d+)\)/);
  assert.ok(match, `stderr should match the packed-summary format, got: ${stderr}`);
  const [, packedTokens, budget] = match.map(Number);
  assert.equal(budget, 50);
  assert.ok(packedTokens <= budget, `packed tokens (${packedTokens}) must never exceed the budget (${budget})`);
  assert.equal(packedTokens, 39);
});

test('pack: --out FILE writes the bundle to disk and leaves stdout empty (summary still goes to stderr)', async () => {
  const outRelPath = 'packed-output.md';
  const outAbsPath = path.join(QUERY_REPO, outRelPath);
  try {
    const { code, stdout, stderr } = runCli(['pack', 'login', '--out', outRelPath], QUERY_REPO);
    assert.equal(code, 0);
    assert.equal(stdout, '', 'stdout must be empty when --out is used');
    assert.ok(stderr.includes('packed 222 tokens (budget 8000)'));

    const written = await fsp.readFile(outAbsPath, 'utf8');
    assert.ok(written.startsWith('# grasp pack: login'));
    assert.ok(written.includes('## src/auth.js'));
  } finally {
    await fsp.unlink(outAbsPath).catch(() => {});
  }
});

test('pack: missing task argument fails with exit 1 and a usage-style error', () => {
  const { code, stderr } = runCli(['pack'], QUERY_REPO);
  assert.equal(code, 1);
  assert.ok(stderr.includes('pack requires a task'));
});

test('pack: with no prior index, fails with exit 1 and points the user at `grasp index`', async () => {
  const repo = await makeTempRepo('grasp-cli-pack-noindex-');
  try {
    const { code, stderr } = runCli(['pack', 'login'], repo);
    assert.equal(code, 1);
    assert.ok(stderr.includes('No grasp index found'));
  } finally {
    await rmDir(repo);
  }
});

// ---------------------------------------------------------------------------
// grasp outline
// ---------------------------------------------------------------------------

test('outline: whole-repo tree groups by directory, sorted, with per-file symbol summaries', () => {
  const { code, stdout } = runCli(['outline'], QUERY_REPO);
  assert.equal(code, 0);

  // Exact, deterministic tree for fixtures/sample (dirs before files at each
  // level, both alphabetically sorted). Note routes.js/util.js each pick up
  // a couple of const-declared local variables in addition to their "real"
  // exported symbols -- symbols.js has no scoping awareness, so this is
  // expected behavior, not a bug, and pins it against regressions either way.
  const expected = [
    'scripts/',
    '  migrate.py (def migrate)',
    'src/',
    '  api/',
    '    routes.js (function registerRoutes, const db, const result)',
    '  auth.js (function login, function logout, const TOKEN_TTL)',
    '  db.js (class Database, method connect, method query)',
    '  util.js (function hash, const h, function slugify)',
    '.gitignore',
    'README.md',
  ].join('\n');

  assert.equal(stdout.trimEnd(), expected);
});

test('outline: a directory argument restricts the tree to that subtree', () => {
  const { code, stdout } = runCli(['outline', 'src'], QUERY_REPO);
  assert.equal(code, 0);

  const expected = [
    'src/',
    '  api/',
    '    routes.js (function registerRoutes, const db, const result)',
    '  auth.js (function login, function logout, const TOKEN_TTL)',
    '  db.js (class Database, method connect, method query)',
    '  util.js (function hash, const h, function slugify)',
  ].join('\n');

  assert.equal(stdout.trimEnd(), expected);
  assert.ok(!stdout.includes('scripts/'));
  assert.ok(!stdout.includes('README.md'));
});

test('outline: a file path renders the per-symbol outlineFile view with exact line ranges', () => {
  const { code, stdout } = runCli(['outline', 'src/auth.js'], QUERY_REPO);
  assert.equal(code, 0);

  const expected = [
    'src/auth.js',
    '  function login  (L3-L9)',
    '  function logout  (L10-L13)',
    '  const TOKEN_TTL  (L14-L15)',
  ].join('\n');

  assert.equal(stdout.trimEnd(), expected);
});

test('outline: a nonexistent subtree prints a placeholder instead of an empty tree', () => {
  const { code, stdout } = runCli(['outline', 'zzz-nonexistent'], QUERY_REPO);
  assert.equal(code, 0);
  assert.equal(stdout.trim(), '(no files under zzz-nonexistent)');
});

test('outline: with no prior index, fails with exit 1 and points the user at `grasp index`', async () => {
  const repo = await makeTempRepo('grasp-cli-outline-noindex-');
  try {
    const { code, stderr } = runCli(['outline'], repo);
    assert.equal(code, 1);
    assert.ok(stderr.includes('No grasp index found'));
  } finally {
    await rmDir(repo);
  }
});

// ---------------------------------------------------------------------------
// grasp stats
// ---------------------------------------------------------------------------

test('stats: prints fileCount, chunkCount, and a language breakdown matching the persisted index', () => {
  const { code, stdout } = runCli(['stats'], QUERY_REPO);
  assert.equal(code, 0);

  const lines = stdout.split('\n').filter(Boolean);
  assert.equal(lines[0], `files: ${INDEX_JSON.fileCount}`);
  assert.equal(lines[1], `chunks: ${INDEX_JSON.chunkCount}`);
  assert.equal(lines[2], 'languages:');
  // Grounded in the deterministic fixture: 4 .js files, 2 extensionless/.md
  // ("text") files (.gitignore, README.md), 1 .py file -- sorted by count
  // desc, then lang name asc.
  assert.deepEqual(lines.slice(3), ['  js: 4', '  text: 2', '  py: 1']);

  assert.equal(INDEX_JSON.fileCount, 7);
  assert.equal(INDEX_JSON.chunkCount, 20);
});

test('stats: with no prior index, fails with exit 1 and points the user at `grasp index`', async () => {
  const repo = await makeTempRepo('grasp-cli-stats-noindex-');
  try {
    const { code, stderr } = runCli(['stats'], repo);
    assert.equal(code, 1);
    assert.ok(stderr.includes('No grasp index found'));
  } finally {
    await rmDir(repo);
  }
});

// ---------------------------------------------------------------------------
// help / version / unknown command
// ---------------------------------------------------------------------------

test('no args, `help`, and `--help` all print the identical usage text with exit 0', () => {
  const noArgs = runCli([], __dirname);
  const help = runCli(['help'], __dirname);
  const flagHelp = runCli(['--help'], __dirname);

  for (const r of [noArgs, help, flagHelp]) {
    assert.equal(r.code, 0);
  }
  assert.equal(noArgs.stdout, help.stdout);
  assert.equal(noArgs.stdout, flagHelp.stdout);

  assert.ok(noArgs.stdout.includes('Usage:'));
  assert.ok(noArgs.stdout.includes('grasp index [path]'));
  assert.ok(noArgs.stdout.includes('grasp ask <task...>'));
  assert.ok(noArgs.stdout.includes('grasp pack <task...>'));
  assert.ok(noArgs.stdout.includes('grasp outline [path]'));
  assert.ok(noArgs.stdout.includes('grasp stats'));
  assert.ok(noArgs.stdout.includes('grasp serve'));
});

test('`version` and `--version` both print exactly "0.1.0" with exit 0', () => {
  const a = runCli(['version'], __dirname);
  const b = runCli(['--version'], __dirname);
  assert.equal(a.code, 0);
  assert.equal(b.code, 0);
  assert.equal(a.stdout.trim(), '0.1.0');
  assert.equal(b.stdout.trim(), '0.1.0');
});

test('an unknown command exits 1 and reports the command name plus usage', () => {
  const { code, stdout, stderr } = runCli(['bogus-command'], __dirname);
  assert.equal(code, 1);
  assert.equal(stdout, '', 'usage/error text goes to stderr, not stdout, for an unknown command');
  assert.ok(stderr.includes('grasp: unknown command: "bogus-command"'));
  assert.ok(stderr.includes('Usage:'));
});
