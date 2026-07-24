// test/color.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStyler, supportsColor, stylerFor } from '../src/color.js';

test('makeStyler(false) is the identity — every styler returns its input unchanged', () => {
  const c = makeStyler(false);
  assert.equal(c.enabled, false);
  assert.equal(c.cyan('hello'), 'hello');
  assert.equal(c.bold(c.magenta('x')), 'x');
  // No ANSI escape bytes may appear when disabled.
  assert.ok(!c.red('danger').includes('\x1b'));
});

test('makeStyler(true) wraps the text in an ANSI code and a reset', () => {
  const c = makeStyler(true);
  const out = c.cyan('hi');
  assert.ok(out.startsWith('\x1b[36m'));
  assert.ok(out.endsWith('\x1b[0m'));
  assert.ok(out.includes('hi'));
});

test('supportsColor: NO_COLOR forces off, FORCE_COLOR forces on, else follows stream.isTTY', () => {
  const saved = { no: process.env.NO_COLOR, force: process.env.FORCE_COLOR };
  try {
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
    assert.equal(supportsColor({ isTTY: true }), true);
    assert.equal(supportsColor({ isTTY: false }), false);
    assert.equal(supportsColor(undefined), false);

    process.env.NO_COLOR = '1';
    assert.equal(supportsColor({ isTTY: true }), false, 'NO_COLOR must win over a TTY');

    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = '1';
    assert.equal(supportsColor({ isTTY: false }), true, 'FORCE_COLOR must win over a non-TTY');
  } finally {
    if (saved.no === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = saved.no;
    if (saved.force === undefined) delete process.env.FORCE_COLOR; else process.env.FORCE_COLOR = saved.force;
  }
});

test('stylerFor returns a working styler object for a given stream', () => {
  const c = stylerFor({ isTTY: false });
  assert.equal(typeof c.cyan, 'function');
  assert.equal(c.cyan('x'), 'x');
});
