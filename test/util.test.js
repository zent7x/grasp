// test/util.test.js
//
// Unit tests for src/util.js: safeResolve, readLines, hashString,
// splitIdentifier, toPosix, fromPosix.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink } from 'node:fs/promises';

import {
  safeResolve,
  readLines,
  hashString,
  splitIdentifier,
  toPosix,
  fromPosix,
} from '../src/util.js';

const FIXTURE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'sample'
);
const AUTH_PATH = path.join(FIXTURE_ROOT, 'src', 'auth.js');

// ---------------------------------------------------------------------------
// safeResolve
// ---------------------------------------------------------------------------

test('safeResolve: resolves a plain relative path to an absolute path inside root', () => {
  const resolved = safeResolve(FIXTURE_ROOT, 'src/auth.js');
  assert.equal(resolved, AUTH_PATH);
});

test('safeResolve: "." resolves to root itself', () => {
  assert.equal(safeResolve(FIXTURE_ROOT, '.'), path.resolve(FIXTURE_ROOT));
});

test('safeResolve: a relative path that traverses back inside root is fine', () => {
  // sub/../src/auth.js normalizes to src/auth.js, still inside root.
  assert.equal(safeResolve(FIXTURE_ROOT, 'sub/../src/auth.js'), AUTH_PATH);
});

test('safeResolve: throws on ".." traversal escaping root', () => {
  assert.throws(() => safeResolve(FIXTURE_ROOT, '../outside.txt'), /path escapes root/);
});

test('safeResolve: throws on deeply nested ".." traversal escaping root', () => {
  assert.throws(
    () => safeResolve(FIXTURE_ROOT, 'src/../../../etc/passwd'),
    /path escapes root/
  );
});

test('safeResolve: throws on an absolute rel path', () => {
  assert.throws(() => safeResolve(FIXTURE_ROOT, '/etc/passwd'), /path escapes root/);
});

test('safeResolve: rejects a sibling directory that merely shares a name prefix', () => {
  // path.resolve('/tmp/foo', '../foo-evil/x.js') = '/tmp/foo-evil/x.js', which
  // is NOT inside '/tmp/foo' even though it shares the string prefix "foo".
  // A naive startsWith('/tmp/foo') check would wrongly allow this.
  assert.throws(() => safeResolve('/tmp/foo', '../foo-evil/x.js'), /path escapes root/);
});

test('safeResolve: hermetic temp repo — legitimate read succeeds, traversal read is blocked', async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'grasp-util-test-'));
  try {
    await mkdir(path.join(tmpRoot, 'nested'), { recursive: true });
    await writeFile(path.join(tmpRoot, 'nested', 'secret.txt'), 'inside root\n', 'utf8');

    const secretOutsideRoot = path.join(os.tmpdir(), 'grasp-util-test-outside-secret.txt');
    await writeFile(secretOutsideRoot, 'outside root\n', 'utf8');

    // Legitimate resolve + read works end to end.
    const abs = safeResolve(tmpRoot, 'nested/secret.txt');
    const content = await readFile(abs, 'utf8');
    assert.equal(content, 'inside root\n');

    // Attempting to escape the temp root to read the sibling file must throw
    // before any read happens.
    assert.throws(
      () => safeResolve(tmpRoot, '../' + path.basename(secretOutsideRoot)),
      /path escapes root/
    );

    await rm(secretOutsideRoot, { force: true });
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test('safeResolve: rejects an in-root symlink whose target is outside root', async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'grasp-util-root-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'grasp-util-outside-'));
  try {
    await writeFile(path.join(outside, 'secret.txt'), 'outside\n');
    await symlink(outside, path.join(tmpRoot, 'escape'));

    assert.throws(
      () => safeResolve(tmpRoot, 'escape/secret.txt'),
      /path escapes root/
    );
    assert.throws(
      () => safeResolve(tmpRoot, 'escape/new-file.txt'),
      /path escapes root/
    );
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// readLines
// ---------------------------------------------------------------------------

test('readLines: with no range returns the whole file, byte-identical to fs.readFile', async () => {
  const whole = await readLines(AUTH_PATH);
  const raw = await readFile(AUTH_PATH, 'utf8');
  assert.equal(whole, raw);
});

test('readLines: returns an exact single 1-based line', async () => {
  const line1 = await readLines(AUTH_PATH, 1, 1);
  assert.equal(line1, '// auth.js — login/logout helpers and token config for the sample fixture repo.');

  const line14 = await readLines(AUTH_PATH, 14, 14);
  assert.equal(line14, 'export const TOKEN_TTL = 3600;');
});

test('readLines: returns an exact inclusive multi-line range spanning the login() body', async () => {
  const body = await readLines(AUTH_PATH, 3, 8);
  assert.equal(
    body,
    [
      'export function login(user) {',
      '  if (!user) {',
      "    throw new Error('user is required');",
      '  }',
      "  return { user, token: 'tok_' + user, expiresIn: TOKEN_TTL };",
      '}',
    ].join('\n')
  );
});

test('readLines: returns "" when startLine > endLine', async () => {
  assert.equal(await readLines(AUTH_PATH, 8, 3), '');
});

test('readLines: returns "" when the range is entirely beyond EOF', async () => {
  assert.equal(await readLines(AUTH_PATH, 100, 105), '');
});

test('readLines: omitting only startLine defaults it to 1', async () => {
  const fromStart = await readLines(AUTH_PATH, undefined, 1);
  assert.equal(fromStart, '// auth.js — login/logout helpers and token config for the sample fixture repo.');
});

// ---------------------------------------------------------------------------
// hashString
// ---------------------------------------------------------------------------

test('hashString: returns the first 12 hex chars of the sha1 digest', () => {
  // sha1('hello') = aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d (well-known test vector)
  assert.equal(hashString('hello'), 'aaf4c61ddcc5');
  assert.match(hashString('anything'), /^[0-9a-f]{12}$/);
});

test('hashString: deterministic for identical input', () => {
  assert.equal(hashString('same input'), hashString('same input'));
});

test('hashString: distinct inputs produce distinct hashes', () => {
  assert.notEqual(hashString('input a'), hashString('input b'));
});

// ---------------------------------------------------------------------------
// splitIdentifier
// ---------------------------------------------------------------------------

test('splitIdentifier: SPEC canonical example getUserID', () => {
  assert.deepEqual(splitIdentifier('getUserID'), ['getuserid', 'get', 'user', 'id']);
});

test('splitIdentifier: a token with no boundaries is emitted exactly once (no dup)', () => {
  assert.deepEqual(splitIdentifier('login'), ['login']);
});

test('splitIdentifier: snake_case fixture symbol TOKEN_TTL', () => {
  assert.deepEqual(splitIdentifier('TOKEN_TTL'), ['token_ttl', 'token', 'ttl']);
});

test('splitIdentifier: kebab-case splits on hyphen boundaries', () => {
  assert.deepEqual(splitIdentifier('foo-bar'), ['foo-bar', 'foo', 'bar']);
});

// ---------------------------------------------------------------------------
// toPosix / fromPosix
// ---------------------------------------------------------------------------

test('toPosix: converts an OS-native-joined path to forward slashes', () => {
  const nativeJoined = ['src', 'api', 'routes.js'].join(path.sep);
  assert.equal(toPosix(nativeJoined), 'src/api/routes.js');
});

test('fromPosix: converts a POSIX path to the OS-native separator', () => {
  const expected = ['src', 'api', 'routes.js'].join(path.sep);
  assert.equal(fromPosix('src/api/routes.js'), expected);
});

test('toPosix / fromPosix: round-trip a POSIX relative path from the fixture', () => {
  const posixRel = 'src/api/routes.js';
  assert.equal(toPosix(fromPosix(posixRel)), posixRel);
});
