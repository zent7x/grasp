// test/walk.test.js
//
// Tests for src/walk.js against both the shared deterministic fixture
// (fixtures/sample) and a hermetic temp repo built with fs.mkdtemp, so the
// gitignore/skip behavior never depends on git actually tracking anything.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { promises as fsp } from 'node:fs';

import { walkRepo } from '../src/walk.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, '..', 'fixtures', 'sample');

// ---------------------------------------------------------------------------
// fixtures/sample — the shared, deterministic repo described in SPEC.md
// ---------------------------------------------------------------------------

test('walkRepo(fixtures/sample) returns exactly the expected non-ignored, non-binary files', async () => {
  const results = await walkRepo(FIXTURE_ROOT);
  const paths = results.map((r) => r.path).sort();

  // Per SPEC.md's fixture guarantees: walk skips ignored/secret.txt (gitignored),
  // assets/logo.bin (binary via NUL sniff, also extension-blocklisted), and .git.
  const expected = [
    '.gitignore',
    'README.md',
    'scripts/migrate.py',
    'src/api/routes.js',
    'src/auth.js',
    'src/db.js',
    'src/util.js',
  ].sort();

  assert.deepEqual(paths, expected, 'walkRepo should return exactly the eligible fixture files, nothing more or less');
});

test('walkRepo(fixtures/sample) excludes gitignored and binary files by name', async () => {
  const results = await walkRepo(FIXTURE_ROOT);
  const paths = results.map((r) => r.path);

  assert.ok(!paths.includes('ignored/secret.txt'), 'gitignored file must be skipped');
  assert.ok(!paths.includes('assets/logo.bin'), 'binary file must be skipped');
  assert.ok(!paths.some((p) => p.startsWith('.git/')), '.git contents must never appear');
});

test('walkRepo(fixtures/sample) returns POSIX-relative paths, correct absPath, and correct size', async () => {
  const results = await walkRepo(FIXTURE_ROOT);
  const byPath = new Map(results.map((r) => [r.path, r]));

  const auth = byPath.get('src/auth.js');
  assert.ok(auth, 'src/auth.js should be present');
  assert.ok(!auth.path.includes('\\'), 'path must be POSIX-style (no backslashes)');
  assert.equal(auth.absPath, path.join(FIXTURE_ROOT, 'src', 'auth.js'));

  const stat = await fsp.stat(auth.absPath);
  assert.equal(auth.size, stat.size, 'reported size must match the real file size on disk');
});

test('walkRepo(fixtures/sample) results are sorted by path for determinism', async () => {
  const results = await walkRepo(FIXTURE_ROOT);
  const paths = results.map((r) => r.path);
  const sorted = [...paths].sort();
  assert.deepEqual(paths, sorted, 'walkRepo output must be sorted ascending by path');
});

// ---------------------------------------------------------------------------
// Hermetic temp repo — exercises gitignore syntax + binary/size rules without
// any dependency on git actually tracking files (walk.js parses .gitignore
// itself; this proves it does so correctly across pattern shapes).
// ---------------------------------------------------------------------------

async function buildTempRepo() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'grasp-walk-test-'));

  async function write(relPath, content) {
    const abs = path.join(root, ...relPath.split('/'));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content);
  }

  await write(
    '.gitignore',
    [
      '# a comment, should be ignored as a pattern line',
      '',
      'ignored_dir/',
      '*.log',
      '!keep.log',
      '/root_anchor.txt',
      'build/**',
    ].join('\n') + '\n'
  );

  // Plain text files that should survive the walk.
  await write('keep.txt', 'kept file at root\n');
  await write('src/main.js', 'export const x = 1;\n');
  await write('sub/root_anchor.txt', 'not anchored here, should survive\n');

  // Directory pattern ('ignored_dir/') — never even recursed into.
  await write('ignored_dir/secret.txt', 'should never be walked\n');
  await write('ignored_dir/nested/deep.txt', 'also should never be walked\n');

  // Unanchored glob ('*.log') matches at any depth.
  await write('a.log', 'root level log\n');
  await write('sub2/b.log', 'nested log\n');

  // Negation ('!keep.log') is explicitly unsupported in v0.1 (gitignore.js
  // skips '!' lines rather than risk mis-un-ignoring something) — so keep.log
  // must still be treated as ignored because the prior '*.log' rule stands.
  await write('keep.log', 'negation is unsupported, this must still be ignored\n');

  // Anchored pattern ('/root_anchor.txt') matches only at repo root, not nested.
  await write('root_anchor.txt', 'anchored, must be ignored\n');

  // 'build/**' — a directory-shaped pattern with interior slash (anchored),
  // everything below build/ must be ignored.
  await write('build/output/file.txt', 'must be ignored via build/**\n');

  // Always-ignored dirs, independent of .gitignore content.
  await write('.git/HEAD', 'ref: refs/heads/main\n');
  await write('node_modules/pkg/index.js', 'module.exports = {};\n');
  await write('.grasp/index.json', '{}\n');

  // Binary via extension blocklist.
  await write('assets/logo.png', 'not real png bytes but extension is enough\n');

  // Binary via NUL-byte sniffing (extension not in the blocklist).
  {
    const abs = path.join(root, 'weird.data');
    const buf = Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x77, 0x6f, 0x72, 0x6c, 0x64]); // "hello\0world"
    await fsp.writeFile(abs, buf);
  }

  // A symlink must never be followed (skip regardless of target).
  await write('real-target.txt', 'a real file elsewhere\n');
  await fsp.symlink(path.join(root, 'real-target.txt'), path.join(root, 'link-to-file.txt'));

  return root;
}

test('walkRepo(hermetic temp repo) respects directory patterns and never recurses into them', async () => {
  const root = await buildTempRepo();
  try {
    const results = await walkRepo(root);
    const paths = results.map((r) => r.path);

    assert.ok(!paths.includes('ignored_dir/secret.txt'));
    assert.ok(!paths.includes('ignored_dir/nested/deep.txt'));
    assert.ok(!paths.some((p) => p.startsWith('ignored_dir/')), 'nothing under ignored_dir/ should ever surface');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('walkRepo(hermetic temp repo) applies unanchored globs at any depth', async () => {
  const root = await buildTempRepo();
  try {
    const results = await walkRepo(root);
    const paths = results.map((r) => r.path);

    assert.ok(!paths.includes('a.log'), 'root-level *.log match must be ignored');
    assert.ok(!paths.includes('sub2/b.log'), 'nested *.log match must be ignored too (unanchored pattern)');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('walkRepo(hermetic temp repo) treats negation lines as unsupported (no un-ignoring)', async () => {
  const root = await buildTempRepo();
  try {
    const results = await walkRepo(root);
    const paths = results.map((r) => r.path);

    assert.ok(
      !paths.includes('keep.log'),
      'negation (!keep.log) is unsupported in v0.1; the underlying *.log rule must still apply'
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('walkRepo(hermetic temp repo) anchored pattern only matches at repo root', async () => {
  const root = await buildTempRepo();
  try {
    const results = await walkRepo(root);
    const paths = results.map((r) => r.path);

    assert.ok(!paths.includes('root_anchor.txt'), 'root-level match for /root_anchor.txt must be ignored');
    assert.ok(
      paths.includes('sub/root_anchor.txt'),
      'the same filename nested under sub/ must survive since the pattern is anchored to root'
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('walkRepo(hermetic temp repo) directory-shaped double-star pattern ignores everything below it', async () => {
  const root = await buildTempRepo();
  try {
    const results = await walkRepo(root);
    const paths = results.map((r) => r.path);

    assert.ok(!paths.includes('build/output/file.txt'), 'build/** must ignore nested content under build/');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('walkRepo(hermetic temp repo) always skips .git, node_modules, and .grasp regardless of .gitignore', async () => {
  const root = await buildTempRepo();
  try {
    const results = await walkRepo(root);
    const paths = results.map((r) => r.path);

    assert.ok(!paths.some((p) => p.startsWith('.git/')));
    assert.ok(!paths.some((p) => p.startsWith('node_modules/')));
    assert.ok(!paths.some((p) => p.startsWith('.grasp/')));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('walkRepo(hermetic temp repo) skips binary files by extension and by NUL-byte sniffing', async () => {
  const root = await buildTempRepo();
  try {
    const results = await walkRepo(root);
    const paths = results.map((r) => r.path);

    assert.ok(!paths.includes('assets/logo.png'), 'extension-blocklisted binary file must be skipped');
    assert.ok(
      !paths.includes('weird.data'),
      'a file with an unrecognized extension but a NUL byte in its first bytes must still be sniffed out as binary'
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('walkRepo(hermetic temp repo) never follows symlinks', async () => {
  const root = await buildTempRepo();
  try {
    const results = await walkRepo(root);
    const paths = results.map((r) => r.path);

    assert.ok(paths.includes('real-target.txt'), 'the real file itself should be walked normally');
    assert.ok(!paths.includes('link-to-file.txt'), 'a symlink entry must never be followed or reported');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('walkRepo(hermetic temp repo) keeps ordinary text files and reports correct path/absPath/size', async () => {
  const root = await buildTempRepo();
  try {
    const results = await walkRepo(root);
    const byPath = new Map(results.map((r) => [r.path, r]));

    const keep = byPath.get('keep.txt');
    assert.ok(keep, 'keep.txt should survive the walk');
    assert.equal(keep.absPath, path.join(root, 'keep.txt'));
    const stat = await fsp.stat(keep.absPath);
    assert.equal(keep.size, stat.size);

    const main = byPath.get('src/main.js');
    assert.ok(main, 'src/main.js should survive the walk');
    assert.equal(main.absPath, path.join(root, 'src', 'main.js'));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('walkRepo(hermetic temp repo) respects a custom maxFileSize override', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'grasp-walk-size-test-'));
  try {
    const smallContent = 'short\n'; // 6 bytes
    const bigContent = 'x'.repeat(500); // 500 bytes

    await fsp.writeFile(path.join(root, 'small.txt'), smallContent);
    await fsp.writeFile(path.join(root, 'big.txt'), bigContent);

    const results = await walkRepo(root, { maxFileSize: 100 });
    const paths = results.map((r) => r.path);

    assert.ok(paths.includes('small.txt'), 'a file under the size cap must be included');
    assert.ok(!paths.includes('big.txt'), 'a file over the size cap must be excluded');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('walkRepo(hermetic temp repo) with no .gitignore present still applies the always-ignored dirs', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'grasp-walk-nogitignore-test-'));
  try {
    await fsp.mkdir(path.join(root, '.git'), { recursive: true });
    await fsp.writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await fsp.writeFile(path.join(root, 'plain.js'), 'export const y = 2;\n');

    const results = await walkRepo(root);
    const paths = results.map((r) => r.path);

    assert.ok(paths.includes('plain.js'));
    assert.ok(!paths.some((p) => p.startsWith('.git/')));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
