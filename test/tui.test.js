// test/tui.test.js
//
// Drives `grasp tui` as a spawned child with piped stdin (non-TTY), so it runs
// one line at a time and exits on EOF/`q`. Verifies a query lists results and a
// numeric selection previews that chunk's source.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { promises as fsp } from 'node:fs';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, '..', 'fixtures', 'sample');
const BIN_PATH = path.join(__dirname, '..', 'bin', 'grasp.js');

async function makeTempRepo() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'grasp-tui-'));
  await fsp.cp(FIXTURE_ROOT, dir, { recursive: true });
  return dir;
}

test('tui: a query lists ranked results and a number opens the chunk source', async () => {
  const repo = await makeTempRepo();
  try {
    // Pre-build the index so the run is deterministic and fast.
    const idx = spawnSync(process.execPath, [BIN_PATH, 'index'], { cwd: repo, encoding: 'utf8' });
    assert.equal(idx.status, 0, idx.stderr);

    // Query "login", open result #1, then quit. NO_COLOR keeps output plain.
    const res = spawnSync(process.execPath, [BIN_PATH, 'tui'], {
      cwd: repo,
      input: 'login\n1\nq\n',
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, NO_COLOR: '1' },
    });
    assert.equal(res.status, 0, `tui should exit 0, stderr: ${res.stderr}`);
    // The header reflects the index.
    assert.ok(res.stdout.includes('grasp'), 'header should mention grasp');
    // The query listed the top result from auth.js.
    assert.ok(res.stdout.includes('src/auth.js:L3-9'), 'query should list the auth.js login chunk');
    // Selecting #1 previewed the actual source of that chunk.
    assert.ok(res.stdout.includes('export function login(user)'), 'selecting #1 should preview the login source');
  } finally {
    await fsp.rm(repo, { recursive: true, force: true });
  }
});
