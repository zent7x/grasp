# grasp — v0.1 engineering contract

**Tagline:** Give any AI coding agent a grasp on a codebase too big to fit in its context window.

`grasp` indexes a repository once, then answers the only question that matters when a repo is
larger than an agent's context window: *for THIS task, what is the minimal set of code the agent
actually needs?* It exposes this as a CLI (for humans + shell) and as an MCP server (so Claude Code,
Cursor, Codex, etc. can pull just-in-time context instead of a human hand-dumping files).

This file is the AUTHORITATIVE INTERFACE CONTRACT. Every module below must implement the exact
exports and behavior described. Implementers: read the global conventions, then implement ONLY your
file, importing siblings by the signatures defined here. Do not invent extra exports. Do not add
runtime dependencies.

---

## Global conventions (MANDATORY)

- **Runtime:** Node >= 18. Developed against Node 24. Use only built-in modules
  (`node:fs`, `node:fs/promises`, `node:path`, `node:crypto`, `node:child_process`, `node:readline`,
  `node:util`, `node:os`). **ZERO third-party runtime dependencies.**
- **Module system:** ESM. `package.json` has `"type": "module"`. All files use `import`/`export`.
  Use `.js` extension in imports (e.g. `import { safeResolve } from './util.js'`).
- **Determinism:** No randomness in indexing/ranking. Given the same repo, output is byte-stable
  (except timestamps in the persisted index, which are allowed).
- **Safety:** Every read of a repo file MUST go through `util.safeResolve(root, rel)` which throws on
  path traversal outside `root`. Never execute repo code. Never follow symlinks outside root.
- **Errors:** Throw `Error` with clear messages. CLI/MCP layers catch and format.
- **Style:** Small, pure functions where possible. No classes unless specified (only `Database` in the
  fixture is a class, and that's fixture data, not our code). Named exports only (no default exports)
  EXCEPT `bin/grasp.js`. `src/cli.js` exports a named `run`.
- **Paths:** Store repo file paths as POSIX-style relative paths (forward slashes) inside the index,
  regardless of OS. Convert with `path.sep` → `/` on write, and back on read for disk access.
- **Token estimate:** `Math.ceil(text.length / 4)` everywhere. One helper: `tokens.estimateTokens`.
- **Index location:** `<root>/.grasp/index.json`.
- **Tests:** `node:test` + `node:assert/strict`. No test framework deps.

---

## Index JSON schema (produced by index-build, persisted by store)

```
{
  version: 1,
  root: "<absolute path>",
  createdAt: <number ms>,           // Date.now() is allowed in real code
  fileCount: <number>,
  chunkCount: <number>,
  files: [
    {
      path: "src/auth.js",          // POSIX relative
      lang: "js",
      size: <bytes>,
      lines: <number>,
      hash: "<sha1 first 12 hex>",
      symbols: [ { name, kind, line, endLine } ],   // 1-based lines; kind: function|class|const|method|type|def|other
      imports: [ "../db.js", "os" ],                // raw specifiers as written
      chunks: [ { id: "3:0", startLine, endLine, symbol: "login"|null } ]  // id = "<fileIndex>:<chunkIndex>"
    }
  ],
  bm25: {
    N: <chunkCount>,
    avgdl: <number>,
    df: { "<term>": <docCount> },
    postings: { "<term>": [ ["<chunkId>", <tf>], ... ] },
    docLen: { "<chunkId>": <length> },
    chunkMeta: { "<chunkId>": { file: "src/auth.js", startLine, endLine, symbol } }
  },
  graph: {
    out: { "src/api/routes.js": ["src/auth.js","src/db.js"] },   // resolved-to-repo edges only
    in:  { "src/auth.js": ["src/api/routes.js"] }
  }
}
```

Chunk text is NOT stored in the index (keeps it lean). `pack`/`read` re-read line ranges from disk.

---

## Fixture repo (fixtures/sample) — DETERMINISTIC, tests assert against it

The fixture-builder implements `fixtures/sample/` with EXACTLY this content so test authors can assert:

- `fixtures/sample/src/auth.js` — ESM. Exports: `export function login(user){...}`,
  `export function logout(){...}`, `export const TOKEN_TTL = 3600;`. Put a top-of-file comment.
- `fixtures/sample/src/db.js` — ESM. `export class Database { connect(){...} query(sql){...} }`.
- `fixtures/sample/src/util.js` — ESM. `export function hash(s){...}`, `export function slugify(s){...}`.
- `fixtures/sample/src/api/routes.js` — ESM. `import { login } from '../auth.js';`
  `import { Database } from '../db.js';` and `export function registerRoutes(app){...}`.
- `fixtures/sample/scripts/migrate.py` — Python. `import os` and `def migrate():` with a body.
- `fixtures/sample/README.md` — a few lines mentioning "login" and "database".
- `fixtures/sample/.gitignore` — contains a line `ignored/`.
- `fixtures/sample/ignored/secret.txt` — arbitrary text; MUST be skipped by walk (gitignored).
- `fixtures/sample/assets/logo.bin` — 512 bytes containing a NUL byte; MUST be skipped (binary).

Guaranteed assertions test authors may rely on:
- walk skips `ignored/secret.txt`, `assets/logo.bin`, and `.git`.
- `auth.js` symbols include names `login`, `logout`, `TOKEN_TTL`.
- `routes.js` imports include `../auth.js` and `../db.js`; graph.out["src/api/routes.js"] resolves to both.
- search/rank for query "login" ranks a chunk from `src/auth.js` first.
- `migrate.py` symbols include `migrate`; imports include `os`.

---

## Ranking algorithm (rank.js) — the core

Given the built index and a task string:
1. `queryTokens = tokenize(task)`.
2. `bm25Scores = bm25.scoreBM25(index.bm25, queryTokens)` → Map(chunkId → score) (k1=1.5, b=0.75).
3. **Symbol boost:** if any queryToken (or its split subtokens) matches a chunk's `symbol` name
   (case-insensitive, after `util.splitIdentifier`), add `+2.0 * bm25MaxScore_normalizedTo1`... keep
   simple: add `+ 1.5` to that chunk's score per matched symbol token (cap +3).
4. **Graph proximity boost:** take the top 10 chunks by current score; for each, find their file's
   graph neighbors (`graph.out` + `graph.in`); any chunk belonging to a neighbor file gets `+0.5`.
5. Sort desc by final score, tie-break by (file asc, startLine asc) for determinism.
6. Return top `opts.top` (default 20) as `[{ file, startLine, endLine, symbol, score, reasons:[str] }]`.

`reasons` is a short human/agent-readable list e.g. `["bm25:4.2","symbol:login","graph:routes.js"]`.

---

## MCP protocol (mcp/server.js + mcp/tools.js)

- Transport: **newline-delimited JSON-RPC 2.0** over stdin/stdout. One JSON object per line.
  Read stdin with `readline`. Write each response as `JSON.stringify(msg) + "\n"`.
- Methods to handle:
  - `initialize` → `{ protocolVersion: "2024-11-05", serverInfo: { name: "grasp", version: "0.1.0" }, capabilities: { tools: {} } }`
  - `tools/list` → `{ tools: TOOLS.map(t => ({name, description, inputSchema})) }`
  - `tools/call` with params `{ name, arguments }` → `{ content: [ { type: "text", text: "<result>" } ] }`
  - `ping` → `{}`
  - Unknown method → JSON-RPC error `-32601`.
- Notifications (no `id`, e.g. `notifications/initialized`) → do not reply.
- On startup ensure an index exists for `ctx.root`; if missing, build it (index-build.buildIndex) then serve.
- `ctx = { root, index }`. Reload index lazily.

### TOOLS (mcp/tools.js exports `TOOLS` and `callTool(name, args, ctx)`)
- `grasp_search` { query: string, top?: number } → ranked results (formatted text: `path:line-line [symbol] score` lines).
- `grasp_outline` { path?: string } → outline string (file or whole repo if omitted).
- `grasp_read` { path: string, startLine?: number, endLine?: number, symbol?: string } → code text (safe, line-numbered).
- `grasp_neighbors` { path: string, depth?: number } → `{ imports:[...], importedBy:[...] }` formatted.
- `grasp_pack` { task: string, budget?: number } → packed markdown bundle (see pack.js).

`callTool` returns a STRING (the text payload). Server wraps it as `{content:[{type:"text",text}]}`.

---

## Per-file interface contract

### src/util.js
- `export function safeResolve(root, rel)` → absolute path; throws `Error("path escapes root")` if the
  resolved path is not inside `root`. Reject `..` traversal and absolute `rel`.
- `export async function readLines(absPath, startLine, endLine)` → string of 1-based inclusive lines
  (whole file if start/end omitted). Returns `""` if range empty.
- `export function hashString(s)` → first 12 hex chars of sha1 (node:crypto).
- `export function splitIdentifier(token)` → array of lowercased subtokens splitting camelCase,
  snake_case, kebab, digits boundaries; includes the whole token too. e.g. `getUserID` → `["getuserid","get","user","id"]`.
- `export function toPosix(p)` / `export function fromPosix(p)` → path separator conversions.

### src/config.js
- `export const DEFAULTS = { maxFileSize: 1_000_000, chunkMaxLines: 60, top: 20, budget: 8000, k1:1.5, b:0.75 }`.
- `export async function loadConfig(root)` → DEFAULTS merged with `<root>/.grasp/config.json` if present.

### src/tokenize.js
- `export function tokenize(text)` → array of tokens: split on non-alphanumeric, then for each raw
  identifier also emit `splitIdentifier` subtokens, lowercase, drop tokens length < 2. Keeps duplicates
  (needed for term frequency). Imports `splitIdentifier` from util.

### src/lang.js
- `export function detectLang(relPath)` → one of `js|ts|jsx|tsx|py|go|rust|java|rb|php|c|cpp|cs|text`.
- `export const LANG_RULES` → map lang → `{ line: RegExp|null (line comment), symbolPatterns: [{kind, re}], importPatterns: [RegExp] }`.
  Provide solid rules for js/ts (function, const arrow, class, method, export, `import ... from 'x'`,
  `require('x')`), py (`def`, `class`, `import x`, `from x import`), and a generic fallback for others.
  Each symbol pattern's capture group 1 = the symbol name.

### src/gitignore.js
- `export async function loadGitignore(root)` → `(relPosixPath) => boolean` (true = ignored).
  Parse `<root>/.gitignore` (and nested is optional; root-level is enough for v0.1). Support `#`
  comments, blank lines, `dir/` (dir prefix), `*` and `**` globs, leading `/` anchor, trailing `/`.
  Convert each pattern to a RegExp. Always also ignore `.git/`, `node_modules/`, `.grasp/`.

### src/walk.js
- `export async function walkRepo(root, opts)` where opts defaults from config. Returns
  `Promise<Array<{ path: posixRel, absPath, size }>>`. Skips: gitignored (via loadGitignore),
  files > maxFileSize, and binary files. Binary detection: extension blocklist
  (`.png .jpg .jpeg .gif .pdf .zip .gz .bin .exe .wasm .ico .woff .woff2 .ttf .mp4 .mp3` etc.) OR a
  NUL byte within the first 8192 bytes. Never recurse into ignored dirs.

### src/symbols.js
- `export function extractSymbols(text, lang)` → `[{ name, kind, line, endLine }]` (1-based).
  Use `LANG_RULES[lang].symbolPatterns` line-by-line. `endLine` = (next symbol's line − 1) or last
  line of file (best-effort; brace/indent matching optional). Dedupe by (name,line).

### src/imports.js
- `export function extractImports(text, lang)` → array of raw import specifiers (strings) as written,
  using `LANG_RULES[lang].importPatterns`. e.g. `../auth.js`, `os`, `react`.

### src/chunk.js
- `export function chunkFile(text, symbols, opts)` → `[{ startLine, endLine, symbol|null }]` covering
  the whole file with no gaps and no overlaps. Prefer symbol boundaries; a symbol longer than
  `opts.chunkMaxLines` is split into consecutive windows (same symbol name on each). Regions with no
  symbol are windowed by `chunkMaxLines`. Lines are 1-based inclusive.

### src/bm25.js
- `export function buildBM25(docs)` where `docs = [{ id, tokens: [...] }]`. Returns
  `{ N, avgdl, df, postings, docLen }` (postings term → `[[id, tf], ...]`).
- `export function scoreBM25(bm25, queryTokens, opts)` → `Map<id, number>` using classic BM25
  (k1 default 1.5, b default 0.75, idf = ln(1 + (N - df + 0.5)/(df + 0.5))). Only positive idf.

### src/graph.js
- `export function buildGraph(files)` where `files` = index `files[]` (need `path` + `imports`).
  Resolve relative import specifiers to actual repo file paths (try as-is, then `+.js/.ts/.py`,
  then `/index.js`). Returns `{ out: {}, in: {} }` (plain objects, POSIX paths, only resolved edges).
- `export function neighbors(graph, filePath, depth=1)` → `{ imports:[...], importedBy:[...] }`
  (BFS to given depth; dedupe; exclude self).

### src/tokens.js
- `export function estimateTokens(text)` → `Math.ceil(text.length/4)`.
- `export function fitToBudget(items, budget, sizeFn)` → greedily returns the prefix of `items` whose
  cumulative `sizeFn` stays <= budget, plus `{ included, dropped, used }`.

### src/outline.js
- `export function outlineFile(fileRecord)` → string: `path` then indented `  kind name  (Lstart-Lend)` per symbol.
- `export function outlineRepo(index, opts)` → string tree grouped by directory; if `opts.dir` given,
  restrict to that subtree. Compact.

### src/rank.js
- `export function rank(index, task, opts)` → implements the Ranking algorithm above. Returns
  `[{ file, startLine, endLine, symbol, score, reasons }]`. Imports tokenize, bm25.scoreBM25, util,
  graph.neighbors. Pure (no disk).

### src/pack.js
- `export async function pack(index, root, task, opts)` → `{ text, included, trimmed, tokens }`.
  Steps: `results = rank(index, task, opts)`; greedily add chunks (re-read via util.readLines) until
  `estimateTokens` cumulative would exceed `opts.budget` (default from config). Dedupe overlapping
  line ranges within a file. For files that had chunks dropped, append a one-line outline note.
  `text` is markdown: a short header, then per file a `` ```lang `` fenced block titled `// path:Lstart-Lend`.
  `included = [{file,startLine,endLine,tokens}]`, `trimmed = [file,...]`, `tokens = total`.

### src/store.js
- `export async function saveIndex(root, index)` → write `<root>/.grasp/index.json` atomically
  (write tmp file in `.grasp/`, then `rename`). Creates `.grasp/` if needed.
- `export async function loadIndex(root)` → parsed index object or `null` if missing.

### src/index-build.js
- `export async function buildIndex(root, opts)` → builds and returns the full index object per schema.
  Pipeline: walkRepo → for each file { read, detectLang, lines, hash, extractSymbols, extractImports,
  chunkFile } → assign chunk ids `"<fileIndex>:<chunkIndex>"` → build bm25 docs (tokens = tokenize of
  each chunk's text, read from disk) → buildBM25 → buildGraph → assemble. If `!opts.noSave`, saveIndex.
  Populate `bm25.chunkMeta` for every chunk.

### src/query.js
- `export async function query(root, task, opts)` → `{ results, index }`. loadIndex (throw a helpful
  error telling the user to run `grasp index` if null), then `rank`.

### src/index.js  (public API barrel)
- Re-export: `buildIndex` (index-build), `query`, `pack`, `rank`, `outlineRepo`, `outlineFile`,
  `loadIndex`, `saveIndex`. Nothing else.

### src/cli.js
- `export async function run(argv)`. Commands:
  - `index [path]` → buildIndex(cwd-or-path); print `indexed <fileCount> files, <chunkCount> chunks → .grasp/index.json`.
  - `ask <task...> [--top N] [--json]` → query + print ranked `path:Lstart-Lend [symbol] score` lines (or JSON).
  - `pack <task...> [--budget N] [--out FILE]` → pack + write to FILE or stdout; print token summary to stderr.
  - `outline [path]` → outlineRepo or outlineFile.
  - `stats` → print index summary (fileCount, chunkCount, top langs).
  - `serve` → start MCP server (import mcp/server.js `startServer`).
  - `help` / `--help` / no args → usage. `version` / `--version` → `0.1.0`.
  - Uses `process.argv` already sliced by bin. Resolve root = process.cwd() unless a path arg is given.
  - Minimal, clean output. No colors dependency (raw ANSI only if you must; keep it plain).

### src/mcp/tools.js
- `export const TOOLS = [ {name, description, inputSchema}, ... ]` (5 tools per MCP section, JSON-Schema inputSchema).
- `export async function callTool(name, args, ctx)` → string. Dispatch to search/outline/read/neighbors/pack
  using rank/pack/outline/graph/util. `grasp_read` MUST use util.safeResolve + util.readLines.

### src/mcp/server.js
- `export async function startServer(opts)` → sets up readline over stdin, ensures index (loadIndex or
  buildIndex), handles JSON-RPC per the MCP protocol section, calls `callTool`. Never throws to top
  level — reply with JSON-RPC errors. Writes only valid JSON lines to stdout (logs go to stderr).

### bin/grasp.js
- Already scaffolded: `#!/usr/bin/env node` importing `run` from `../src/cli.js`.

---

## Test expectations (test/*.test.js)
Each test file uses `node:test` + `node:assert/strict`, imports the module under test directly, and
where a repo is needed uses `fixtures/sample` (absolute path via `import.meta.dirname`/`fileURLToPath`).
`test/integration.test.js` must: buildIndex on fixtures/sample (noSave:true), assert fileCount excludes
ignored+binary, assert `grasp ask "login"` top result is from `src/auth.js`, assert `pack` respects a
small budget (e.g. 300 tokens) and returns `tokens <= budget`. `test/cli.test.js` spawns
`node bin/grasp.js index` + `ask` in a temp copy of the fixture and checks exit code 0 and output.
`test/mcp.test.js` spawns the server, sends `initialize` + `tools/list` + a `grasp_search` `tools/call`
over stdin, and asserts well-formed JSON-RPC responses.

All tests must pass under `node --test`.

---

## Clarifications (added during harden)

These pin choices the prose left open so parallel implementers stay compatible. They refine, never override, the contract above.

1. **chunkId is the one join key.** The string `"<fileIndex>:<chunkIndex>"` is byte-identical across `files[].chunks[].id`, all bm25 `postings`/`docLen` ids, and `bm25.chunkMeta` keys. `rank` is pure (no disk): it MUST resolve a scored chunkId → `{file,startLine,endLine,symbol}` **solely via `index.bm25.chunkMeta`**. That is also how it finds which chunks "belong to" a file.
2. **tokenize — no double count.** For each raw alphanumeric token emit exactly `splitIdentifier(raw)` (which already includes the whole token) — do NOT additionally emit the raw token. So `login`→`login` (once); `getUserID`→`getuserid,get,user,id`. Then drop any subtoken with length < 2. Duplicates arising from different raw tokens are kept (term frequency). Same tokenizer is used for indexing and for `task`.
3. **LANG_RULES total coverage.** `LANG_RULES` MUST have a key for every value `detectLang` can return (`js ts jsx tsx py go rust java rb php c cpp cs text`). `jsx`/`tsx` reuse the js/ts rules; all others without bespoke rules share one generic rule object. Consumers may index `LANG_RULES[lang]` directly and assume it is defined (no `||` fallback).
4. **Symbol boost = canonical rule.** Ignore the "+2.0 * bm25Max" phrasing. For each query subtoken (post-`splitIdentifier`) that case-insensitively equals a `splitIdentifier` subtoken of the chunk's `chunkMeta.symbol`, add `+1.5`, capped at `+3.0` total per chunk.
5. **Boosts never introduce chunks.** Both the symbol boost (step 3) and graph-proximity boost (step 4) apply ONLY to chunkIds already present in the `scoreBM25` result Map (bm25 score > 0). Neither ever creates a new map entry — a chunk with no query-term match can never enter results.
6. **Graph proximity detail.** From the top-10 chunks by post-symbol-boost score, take each chunk's file, gather neighbors via `neighbors(graph, file, 1)` (union of `imports`+`importedBy`); every already-scored chunk whose `chunkMeta.file` is in that neighbor set gets `+0.5` once total (not per neighbor).
7. **scoreBM25 params in rank.** `rank` calls `scoreBM25(index.bm25, queryTokens)` with NO third arg, so scoreBM25's own defaults (k1=1.5, b=0.75) apply. Config `k1`/`b` are NOT threaded into ranking in v0.1.
8. **fitToBudget return.** Returns `{ included: Item[], dropped: Item[], used: number }`. Prefix semantics: iterate in order and stop at the FIRST item whose addition would push cumulative `sizeFn` above `budget`; that item and all following go to `dropped`. `used` = summed `sizeFn` of `included` only.
9. **pack budget + tokens.** The budget bounds only the SUM of included chunks' code tokens (markdown header/fences/titles are NOT counted). Each `included[i].tokens = estimateTokens(rawCode)` where rawCode is the un-numbered `readLines` output; top-level `tokens` = Σ `included[].tokens`, so `tokens <= budget` always. Stop before adding a chunk that would exceed budget. Fenced code in `pack` is NOT line-numbered (unlike `grasp_read`); its only annotation is the title `// path:Lstart-Lend`.
10. **Null-symbol output.** In `grasp_search` and CLI `ask` lines, when `symbol` is null omit the `[symbol]` segment entirely → `path:Lstart-Lend score`. `grasp_search` uses the same `Lstart-Lend` location form as the CLI.
11. **graph edges.** `graph.out`/`graph.in` contain keys ONLY for files with ≥1 resolved edge (never empty arrays). Resolution is relative to the importer's POSIX dirname; only specifiers beginning with `.` are resolved (try as-is, then `+.js/.ts/.py`, then `/index.js`); bare specifiers (`os`,`react`) are dropped from the graph.
