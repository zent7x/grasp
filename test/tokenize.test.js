// test/tokenize.test.js
//
// Unit tests for src/tokenize.js. tokenize() is the shared term-extraction
// step used both to build BM25 postings at index time and to tokenize the
// `task` query string at rank time (SPEC.md src/tokenize.js + clarification
// #2), so these tests pin: raw-token splitting on non-alphanumeric runs,
// identifier expansion via splitIdentifier (no double-counting the raw
// form), the length < 2 subtoken drop, and term-frequency-preserving
// duplicates. The final group tokenizes the REAL fixtures/sample/src/auth.js
// file to ground tokenize() against the fixture guarantees SPEC.md pins for
// rank.js (query "login" must be able to match a chunk from auth.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { tokenize } from '../src/tokenize.js';

const FIXTURE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/sample'
);

test('tokenize: plain word with no identifier boundaries emits itself once, lowercased', () => {
  assert.deepEqual(tokenize('login'), ['login']);
  assert.deepEqual(tokenize('Login'), ['login']);
});

test('tokenize: camelCase identifier expands via splitIdentifier WITHOUT double-emitting the raw token (SPEC clarification #2)', () => {
  // splitIdentifier("getUserID") already returns the whole token as its
  // first element, so tokenize must emit exactly that array, not the raw
  // token plus subtokens.
  assert.deepEqual(tokenize('getUserID'), ['getuserid', 'get', 'user', 'id']);
});

test('tokenize: underscore is a raw-token separator, so snake_case halves are tokenized independently', () => {
  // "TOKEN_TTL" never reaches splitIdentifier as one string: the outer
  // /[A-Za-z0-9]+/g match in tokenize() already splits it into "TOKEN" and
  // "TTL" at the underscore. Each half has no internal camelCase boundary,
  // so splitIdentifier just lowercases the whole piece and nothing else.
  assert.deepEqual(tokenize('TOKEN_TTL'), ['token', 'ttl']);
});

test('tokenize: acronym-then-word boundary splits (HTTPServer -> whole + HTTP + Server)', () => {
  assert.deepEqual(tokenize('HTTPServer'), ['httpserver', 'http', 'server']);
});

test('tokenize: subtokens shorter than 2 chars are dropped, surviving whole token is kept', () => {
  // splitIdentifier("v2beta") -> ["v2beta","v","2","beta"]; "v" and "2" are
  // length 1 and must be filtered out by tokenize, leaving the whole token
  // and "beta".
  assert.deepEqual(tokenize('v2beta'), ['v2beta', 'beta']);
});

test('tokenize: duplicates across repeated raw tokens are preserved (term-frequency signal for BM25)', () => {
  assert.deepEqual(tokenize('login login'), ['login', 'login']);
});

test('tokenize: punctuation-only text yields no tokens', () => {
  assert.deepEqual(tokenize('!!! --- ...'), []);
});

test('tokenize: empty string and non-string input all yield an empty array', () => {
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize(undefined), []);
  assert.deepEqual(tokenize(null), []);
});

test('tokenize: splits multi-word punctuated text into raw tokens in order', () => {
  assert.deepEqual(tokenize('login, logout!'), ['login', 'logout']);
});

test('tokenize: a task string is tokenized with the same rules as source text (SPEC: "same tokenizer is used for indexing and for task")', () => {
  assert.deepEqual(tokenize('fix the login bug'), ['fix', 'the', 'login', 'bug']);
});

test('tokenize: real fixtures/sample/src/auth.js surfaces the exact terms rank.js needs for query "login" (SPEC fixture guarantee)', async () => {
  const authPath = path.join(FIXTURE_ROOT, 'src', 'auth.js');
  const text = await readFile(authPath, 'utf8');
  const tokens = tokenize(text);

  const countOf = (term) => tokens.filter((t) => t === term).length;

  // SPEC.md pins auth.js's exact content: a top-of-file comment mentioning
  // "login/logout", `export function login(user)`, `export function
  // logout()`, and `export const TOKEN_TTL = 3600`. That gives an exact,
  // countable number of raw-token occurrences of each term, independent of
  // implementation details elsewhere in the pipeline (symbols/imports/chunk).
  assert.equal(countOf('login'), 2, 'one from the header comment, one from the function name');
  assert.equal(countOf('logout'), 2, 'one from the header comment, one from the function name');
  assert.equal(countOf('ttl'), 2, 'one from each of the two TOKEN_TTL occurrences (usage + declaration)');

  // "token" additionally appears as a subtoken of "expiresIn"'s neighbor
  // property key `token:` and both TOKEN_TTL occurrences, on top of the
  // header comment's own use of the word "token" -- confirm it is indexable
  // at all without over-pinning the exact count of every contributing site.
  assert.ok(tokens.includes('token'));

  // camelCase property names inside the function body are also expanded,
  // e.g. `expiresIn` contributes both "expires" and "in" as separate terms.
  assert.ok(tokens.includes('expires'));
  assert.ok(tokens.includes('expiresin'));
});
