// test/bm25.test.js
//
// Unit tests for src/bm25.js — the pure BM25 index builder/scorer.
//
// Two layers of coverage:
//   1. A tiny hand-computed synthetic corpus, used to pin buildBM25's exact
//      structural output and to cross-check scoreBM25's numeric output
//      against an independently re-derived implementation of the formula in
//      SPEC.md (not scoreBM25 itself), plus edge-case behavior (empty/unknown
//      query terms, duplicate-token scaling, custom k1/b).
//   2. fixtures/sample's real source files, tokenized with the real
//      tokenize.js, so df/postings/ranking assertions are grounded in this
//      repo's known, stable fixture content (per SPEC.md's fixture
//      contract) rather than made-up text.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildBM25, scoreBM25 } from '../src/bm25.js';
import { tokenize } from '../src/tokenize.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, '..', 'fixtures', 'sample');

// ---------------------------------------------------------------------------
// Independent reference implementation of the BM25 formula, re-derived from
// SPEC.md's own definition (NOT copy-pasted from bm25.js), used to
// cross-check scoreBM25's numeric output:
//   idf(t)      = ln(1 + (N - df(t) + 0.5) / (df(t) + 0.5))
//   score(D, t) = idf(t) * (tf(t,D) * (k1+1)) / (tf(t,D) + k1*(1 - b + b*|D|/avgdl))
// ---------------------------------------------------------------------------
function referenceScore(tf, dl, avgdl, df, N, k1 = 1.5, b = 0.75) {
  const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
  return (idf * (tf * (k1 + 1))) / (tf + k1 * (1 - b + b * (dl / avgdl)));
}

function closeTo(actual, expected, epsilon = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) < epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`
  );
}

// ---------------------------------------------------------------------------
// Tiny synthetic corpus for exact, hand-verifiable structural + numeric
// assertions, decoupled from tokenization/fixture concerns.
//   d1: "cat cat dog" (len 3), d2: "dog dog dog" (len 3), d3: "bird" (len 1)
// ---------------------------------------------------------------------------
const SYNTH_DOCS = [
  { id: 'd1', tokens: ['cat', 'cat', 'dog'] },
  { id: 'd2', tokens: ['dog', 'dog', 'dog'] },
  { id: 'd3', tokens: ['bird'] },
];

test('buildBM25: structural fields on a tiny synthetic corpus', () => {
  const bm25 = buildBM25(SYNTH_DOCS);

  assert.equal(bm25.N, 3);
  closeTo(bm25.avgdl, 7 / 3);
  assert.deepEqual(bm25.docLen, { d1: 3, d2: 3, d3: 1 });
  assert.deepEqual(bm25.df, { cat: 1, dog: 2, bird: 1 });
  assert.deepEqual(bm25.postings.cat, [['d1', 2]]);
  assert.deepEqual(bm25.postings.dog, [['d1', 1], ['d2', 3]]);
  assert.deepEqual(bm25.postings.bird, [['d3', 1]]);
});

test('buildBM25: empty corpus yields zeroed/empty structures', () => {
  const bm25 = buildBM25([]);
  assert.equal(bm25.N, 0);
  assert.equal(bm25.avgdl, 0);
  assert.deepEqual(bm25.df, {});
  assert.deepEqual(bm25.postings, {});
  assert.deepEqual(bm25.docLen, {});
});

test('scoreBM25: matches the SPEC BM25 formula exactly (k1=1.5, b=0.75 defaults)', () => {
  const bm25 = buildBM25(SYNTH_DOCS);

  const catScores = scoreBM25(bm25, ['cat']);
  assert.equal(catScores.size, 1);
  closeTo(catScores.get('d1'), referenceScore(2, 3, bm25.avgdl, 1, 3));

  const dogScores = scoreBM25(bm25, ['dog']);
  assert.equal(dogScores.size, 2);
  closeTo(dogScores.get('d1'), referenceScore(1, 3, bm25.avgdl, 2, 3));
  closeTo(dogScores.get('d2'), referenceScore(3, 3, bm25.avgdl, 2, 3));
  // "dog" appears 3x in d2 vs 1x in d1 at identical document length -> d2
  // must outrank d1 (monotonic in tf when length is held constant).
  assert.ok(dogScores.get('d2') > dogScores.get('d1'));

  const birdScores = scoreBM25(bm25, ['bird']);
  assert.equal(birdScores.size, 1);
  closeTo(birdScores.get('d3'), referenceScore(1, 1, bm25.avgdl, 1, 3));
});

test('scoreBM25: honors custom k1/b instead of silently using defaults', () => {
  const bm25 = buildBM25(SYNTH_DOCS);
  const custom = scoreBM25(bm25, ['cat'], { k1: 1.2, b: 0.5 });
  closeTo(custom.get('d1'), referenceScore(2, 3, bm25.avgdl, 1, 3, 1.2, 0.5));

  // Sanity: the custom params must actually move the score vs. the default.
  const withDefaults = scoreBM25(bm25, ['cat']);
  assert.notEqual(custom.get('d1'), withDefaults.get('d1'));
});

test("scoreBM25: duplicate query tokens scale a term's contribution linearly", () => {
  const bm25 = buildBM25(SYNTH_DOCS);
  const once = scoreBM25(bm25, ['dog']).get('d2');
  const twice = scoreBM25(bm25, ['dog', 'dog']).get('d2');
  const thrice = scoreBM25(bm25, ['dog', 'dog', 'dog']).get('d2');
  closeTo(twice, once * 2);
  closeTo(thrice, once * 3);
});

test('scoreBM25: unknown query terms are ignored, not crashing and not diluting known terms', () => {
  const bm25 = buildBM25(SYNTH_DOCS);
  const plain = scoreBM25(bm25, ['cat']);
  const withUnknown = scoreBM25(bm25, ['cat', 'nonexistentterm']);
  assert.equal(withUnknown.size, plain.size);
  assert.equal(withUnknown.get('d1'), plain.get('d1'));
});

test('scoreBM25: a query of only unseen terms returns an empty Map (no zero-score entries)', () => {
  const bm25 = buildBM25(SYNTH_DOCS);
  const scores = scoreBM25(bm25, ['nonexistentterm']);
  assert.equal(scores.size, 0);
});

test('scoreBM25: empty/invalid queryTokens returns an empty Map', () => {
  const bm25 = buildBM25(SYNTH_DOCS);
  assert.equal(scoreBM25(bm25, []).size, 0);
});

// ---------------------------------------------------------------------------
// Grounded in fixtures/sample: build BM25 over the real, tokenized fixture
// source files (per SPEC.md's fixture contract) instead of synthetic text,
// so df/postings/ranking assertions are tied to content this repo guarantees
// to be stable.
// ---------------------------------------------------------------------------

const FIXTURE_FILES = [
  'src/auth.js',
  'src/db.js',
  'src/util.js',
  'src/api/routes.js',
  'scripts/migrate.py',
  'README.md',
];

async function buildFixtureBM25() {
  const docs = [];
  const rawTokensByFile = {};
  for (const rel of FIXTURE_FILES) {
    const text = await readFile(path.join(FIXTURE_ROOT, rel), 'utf8');
    const tokens = tokenize(text);
    rawTokensByFile[rel] = tokens;
    docs.push({ id: rel, tokens });
  }
  return { bm25: buildBM25(docs), rawTokensByFile };
}

test('buildBM25 on fixtures/sample: docLen matches tokenize() length per file', async () => {
  const { bm25, rawTokensByFile } = await buildFixtureBM25();
  assert.equal(bm25.N, FIXTURE_FILES.length);
  for (const rel of FIXTURE_FILES) {
    assert.equal(bm25.docLen[rel], rawTokensByFile[rel].length);
  }
});

test('buildBM25 on fixtures/sample: "login"/"database" df+postings match known fixture content', async () => {
  const { bm25 } = await buildFixtureBM25();

  // Per SPEC: auth.js has login/logout (comment + `function login`), routes.js
  // imports login, registers `POST '/login'`, and calls login(), and README.md's
  // blurb mentions "login" twice ("basic login" + "login/logout").
  assert.equal(bm25.df.login, 3);
  assert.deepEqual(
    new Map(bm25.postings.login),
    new Map([
      ['src/auth.js', 2],
      ['src/api/routes.js', 3],
      ['README.md', 2],
    ])
  );

  // Per SPEC: db.js defines `class Database` (comment + declaration), routes.js
  // imports and instantiates Database, and README.md's blurb mentions
  // "database" twice ("database layer" + "database client").
  assert.equal(bm25.df.database, 3);
  assert.deepEqual(
    new Map(bm25.postings.database),
    new Map([
      ['src/db.js', 2],
      ['src/api/routes.js', 2],
      ['README.md', 2],
    ])
  );

  // Neither term appears in util.js or migrate.py at all.
  const loginDocs = new Set(bm25.postings.login.map(([id]) => id));
  const databaseDocs = new Set(bm25.postings.database.map(([id]) => id));
  for (const rel of ['src/util.js', 'scripts/migrate.py']) {
    assert.ok(!loginDocs.has(rel), `login must not appear in ${rel}`);
    assert.ok(!databaseDocs.has(rel), `database must not appear in ${rel}`);
  }
});

test('buildBM25 on fixtures/sample: "migrate"/"ttl" are exclusive to their one file', async () => {
  const { bm25 } = await buildFixtureBM25();

  // "migrate" only occurs (as `def migrate():`) in scripts/migrate.py, per
  // SPEC's "migrate.py symbols include migrate" guarantee.
  assert.equal(bm25.df.migrate, 1);
  assert.deepEqual(bm25.postings.migrate, [['scripts/migrate.py', 1]]);

  // TOKEN_TTL's "ttl" piece is unique to auth.js. The raw-token regex in
  // tokenize.js splits on the underscore before splitIdentifier ever runs,
  // so "TOKEN_TTL" surfaces as two independent all-caps raw tokens ("TOKEN",
  // "TTL") rather than one combined "token_ttl" subtoken; "ttl" appears once
  // per each of TOKEN_TTL's two occurrences in auth.js.
  assert.equal(bm25.df.ttl, 1);
  assert.deepEqual(bm25.postings.ttl, [['src/auth.js', 2]]);
});

test('scoreBM25 on fixtures/sample: "login" query only scores the 3 files that mention it', async () => {
  const { bm25 } = await buildFixtureBM25();
  const scores = scoreBM25(bm25, tokenize('login'));

  assert.equal(scores.size, 3);
  assert.ok(scores.has('src/auth.js'));
  assert.ok(scores.has('src/api/routes.js'));
  assert.ok(scores.has('README.md'));
  assert.ok(!scores.has('src/db.js'));
  assert.ok(!scores.has('src/util.js'));
  assert.ok(!scores.has('scripts/migrate.py'));

  for (const score of scores.values()) {
    assert.ok(score > 0);
  }

  // routes.js mentions "login" 3x (import + the '/login' route string + the
  // call site) versus auth.js's 2x in a shorter file, so raw BM25 alone (no
  // chunking, no symbol-name boost) ranks routes.js above auth.js here. This
  // is scoreBM25 in isolation, NOT the full rank.js pipeline -- rank.js's
  // symbol boost is what makes SPEC's "search for 'login' ranks a chunk from
  // src/auth.js first" guarantee hold end-to-end.
  assert.ok(scores.get('src/api/routes.js') > scores.get('src/auth.js'));
  assert.ok(scores.get('src/auth.js') > scores.get('README.md'));
});

test('scoreBM25 on fixtures/sample: "migrate" query isolates scripts/migrate.py', async () => {
  const { bm25 } = await buildFixtureBM25();
  const scores = scoreBM25(bm25, tokenize('migrate'));
  assert.equal(scores.size, 1);
  assert.ok(scores.get('scripts/migrate.py') > 0);
});

test('prototype-named terms and document ids are indexed and scored as ordinary strings', () => {
  const names = ['constructor', 'toString', '__proto__'];
  const docs = names.map((name) => ({ id: name, tokens: [name] }));
  const bm25 = buildBM25(docs);

  for (const name of names) {
    assert.equal(Object.hasOwn(bm25.df, name), true);
    assert.equal(bm25.df[name], 1);
    assert.deepEqual(bm25.postings[name], [[name, 1]]);
    assert.equal(bm25.docLen[name], 1);
  }

  const scores = scoreBM25(bm25, names);
  assert.deepEqual(new Set(scores.keys()), new Set(names));
  for (const score of scores.values()) assert.ok(score > 0);
});

test('unseen prototype-named query terms are ignored instead of reading inherited properties', () => {
  const bm25 = buildBM25([{ id: 'safe', tokens: ['ordinary'] }]);
  const scores = scoreBM25(bm25, ['constructor', 'toString', '__proto__']);
  assert.deepEqual(scores, new Map());
});
