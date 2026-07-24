// test/gitignore.test.js
//
// Exercises src/gitignore.js (loadGitignore) directly, plus its real effect
// on src/walk.js (walkRepo), since the two are only meaningfully testable
// together for the "does this actually get skipped" guarantees in SPEC.md.
//
// Two kinds of fixtures are used:
//   1. fixtures/sample — the repo-wide deterministic fixture SPEC.md pins
//      exact assertions against (ignored/secret.txt must be skipped, etc).
//   2. hermetic temp repos built with fs.mkdtemp — used for .gitignore syntax
//      edge cases (anchors, globs, negation, missing file) that fixtures/sample
//      doesn't cover and that must not depend on real git tracking state.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadGitignore } from '../src/gitignore.js';
import { walkRepo } from '../src/walk.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, '..', 'fixtures', 'sample');

// Build a hermetic temp repo: `files` maps POSIX-relative path -> content.
// `gitignoreContent` is written to <dir>/.gitignore, or omitted entirely when
// null so tests can exercise the "no .gitignore present" fallback path.
async function makeTempRepo(files, gitignoreContent) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grasp-gitignore-'));
  if (gitignoreContent != null) {
    await fs.writeFile(path.join(dir, '.gitignore'), gitignoreContent, 'utf8');
  }
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }
  return dir;
}

async function withTempRepo(files, gitignoreContent, fn) {
  const dir = await makeTempRepo(files, gitignoreContent);
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('loadGitignore — fixtures/sample (SPEC-pinned fixture)', () => {
  test('matches the "ignored/" pattern from fixtures/sample/.gitignore', async () => {
    const isIgnored = await loadGitignore(FIXTURE_ROOT);
    assert.equal(isIgnored('ignored/secret.txt'), true);
    assert.equal(isIgnored('ignored/'), true, 'a directory probe must match a dir-prefix pattern');
    assert.equal(isIgnored('ignored'), false, 'a regular file with the same name must not match ignored/');
  });

  test('does not ignore any of the real fixture source files', async () => {
    const isIgnored = await loadGitignore(FIXTURE_ROOT);
    for (const p of [
      'src/auth.js',
      'src/db.js',
      'src/util.js',
      'src/api/routes.js',
      'scripts/migrate.py',
      'README.md',
    ]) {
      assert.equal(isIgnored(p), false, `expected ${p} to NOT be ignored`);
    }
  });

  test('always ignores .git/, node_modules/, .grasp/ regardless of .gitignore contents', async () => {
    const isIgnored = await loadGitignore(FIXTURE_ROOT);
    assert.equal(isIgnored('.git/HEAD'), true);
    assert.equal(isIgnored('node_modules/some-pkg/index.js'), true);
    assert.equal(isIgnored('.grasp/index.json'), true);
  });

  test('walkRepo(fixtures/sample) actually skips the gitignored dir and binary file', async () => {
    const files = await walkRepo(FIXTURE_ROOT);
    const paths = files.map((f) => f.path);

    assert.ok(!paths.includes('ignored/secret.txt'), 'ignored/secret.txt must be skipped');
    assert.ok(!paths.some((p) => p.startsWith('ignored/')), 'nothing under ignored/ may appear');
    assert.ok(!paths.includes('assets/logo.bin'), 'assets/logo.bin must be skipped (binary, unrelated to gitignore)');

    // Sanity: the walk isn't just returning an empty list — real source files
    // from the fixture must still come through.
    assert.ok(paths.includes('src/auth.js'));
    assert.ok(paths.includes('src/api/routes.js'));
    assert.ok(paths.includes('scripts/migrate.py'));
  });
});

describe('loadGitignore — syntax edge cases (hermetic temp repos)', () => {
  test('comments and blank lines are not treated as patterns', async () => {
    await withTempRepo(
      { 'foo.txt': 'hello', 'bar.txt': 'world' },
      '# foo.txt\n\n   \n# another comment\n',
      async (dir) => {
        const isIgnored = await loadGitignore(dir);
        assert.equal(isIgnored('foo.txt'), false, 'a commented-out pattern must have no effect');
        assert.equal(isIgnored('bar.txt'), false);
      },
    );
  });

  test('leading "/" anchors a pattern to the repo root only', async () => {
    await withTempRepo(
      { 'build/out.js': 'x', 'src/build/out.js': 'y' },
      '/build\n',
      async (dir) => {
        const isIgnored = await loadGitignore(dir);
        assert.equal(isIgnored('build/out.js'), true, 'root-level build/ must be ignored');
        assert.equal(
          isIgnored('src/build/out.js'),
          false,
          'an anchored pattern must not match a nested dir of the same name',
        );
      },
    );
  });

  test('a trailing-"/" dir pattern without a leading slash matches at any depth', async () => {
    await withTempRepo(
      { 'dist/out.js': 'x', 'pkg/dist/out.js': 'y', 'distant.txt': 'z' },
      'dist/\n',
      async (dir) => {
        const isIgnored = await loadGitignore(dir);
        assert.equal(isIgnored('dist/out.js'), true);
        assert.equal(isIgnored('pkg/dist/out.js'), true);
        assert.equal(isIgnored('dist/'), true, 'a directory probe with a trailing slash must match');
        assert.equal(isIgnored('dist'), false, 'a regular file named dist must not match dist/');
        assert.equal(isIgnored('distant.txt'), false, 'a similarly-named file must not match a dir pattern');
      },
    );
  });

  test('"*" matches within one path segment but never across a "/"', async () => {
    await withTempRepo(
      { 'app.log': 'x', 'logs/app.log': 'y', 'app.log.bak': 'z' },
      '*.log\n',
      async (dir) => {
        const isIgnored = await loadGitignore(dir);
        assert.equal(isIgnored('app.log'), true);
        assert.equal(isIgnored('logs/app.log'), true, 'unanchored *.log must match at any depth');
        assert.equal(isIgnored('app.log.bak'), false, '*.log must not match a different trailing extension');
      },
    );
  });

  test('"?" matches exactly one non-separator character', async () => {
    await withTempRepo(
      { 'a1.tmp': 'x', 'ab.tmp': 'y', 'a12.tmp': 'z' },
      'a?.tmp\n',
      async (dir) => {
        const isIgnored = await loadGitignore(dir);
        assert.equal(isIgnored('a1.tmp'), true);
        assert.equal(isIgnored('ab.tmp'), true);
        assert.equal(isIgnored('a12.tmp'), false, '? must match exactly one character, not two');
      },
    );
  });

  test('"**" matches zero or more whole path segments', async () => {
    await withTempRepo(
      {
        'a/b/keep.txt': '1',
        'a/x/b/keep.txt': '2',
        'a/x/y/b/keep.txt': '3',
        'a/other/keep.txt': '4',
      },
      'a/**/b\n',
      async (dir) => {
        const isIgnored = await loadGitignore(dir);
        assert.equal(isIgnored('a/b/keep.txt'), true, 'a/**/b must match zero intermediate segments');
        assert.equal(isIgnored('a/x/b/keep.txt'), true);
        assert.equal(isIgnored('a/x/y/b/keep.txt'), true);
        assert.equal(isIgnored('a/other/keep.txt'), false);
      },
    );
  });

  test('negated ("!") patterns are unsupported and skipped, not applied', async () => {
    await withTempRepo(
      { 'app.log': 'x', 'important.log': 'y' },
      '*.log\n!important.log\n',
      async (dir) => {
        const isIgnored = await loadGitignore(dir);
        assert.equal(isIgnored('app.log'), true);
        assert.equal(
          isIgnored('important.log'),
          true,
          'an unsupported negation must not un-ignore a previously-matched file',
        );
      },
    );
  });

  test('a repo with no .gitignore file falls back to just the always-ignored set', async () => {
    await withTempRepo({ 'src/keep.js': 'x' }, null, async (dir) => {
      const isIgnored = await loadGitignore(dir);
      assert.equal(isIgnored('src/keep.js'), false);
      assert.equal(isIgnored('node_modules/pkg/index.js'), true);
      assert.equal(isIgnored('.git/HEAD'), true);
      assert.equal(isIgnored('.grasp/index.json'), true);
    });
  });

  test('walkRepo on a hermetic repo actually skips a gitignored directory tree', async () => {
    await withTempRepo(
      {
        'src/keep.js': 'export const x = 1;\n',
        'build/out.js': 'generated',
        'build/nested/deep.js': 'generated deep',
      },
      'build/\n',
      async (dir) => {
        const files = await walkRepo(dir);
        const paths = files.map((f) => f.path).sort();
        assert.deepEqual(paths, ['.gitignore', 'src/keep.js']);
      },
    );
  });
});
