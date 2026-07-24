# grasp

Give any AI coding agent a grasp on a codebase too big to fit in its context window.

`grasp` builds a compact local index of a repository, ranks code for a task, and packs the most relevant source into a token-budgeted Markdown bundle. It also exposes the same workflow as an MCP server over stdio.

## Requirements

- Node.js 18 or newer
- No runtime dependencies

## Install from a checkout

```sh
npm install -g .
```

## Quick start

Run these commands from the repository you want to inspect:

```sh
grasp index
grasp ask "add authentication to the login route"
grasp pack "add authentication to the login route" --budget 8000 --out context.md
grasp outline
grasp stats
```

The index is written to `.grasp/index.json`. Add a `.grasp/config.json` file to override defaults such as `maxFileSize`, `chunkMaxLines`, `top`, and `budget`.

Run `grasp help` for the complete command reference.

## MCP

Point an MCP client at the repository and start `grasp` over stdio:

```json
{
  "mcpServers": {
    "grasp": {
      "command": "grasp",
      "args": ["serve"],
      "cwd": "/absolute/path/to/repository"
    }
  }
}
```

The server creates the index when it is missing and provides tools for search, outlines, safe source reads, import neighbors, and context packing.

## Programmatic API

```js
import { buildIndex, query, pack } from 'grasp';

const root = process.cwd();
const index = await buildIndex(root);
const { results } = await query(root, 'trace the login flow', { top: 10 });
const bundle = await pack(index, root, 'trace the login flow', { budget: 8000 });
```

The package also exports `rank`, `outlineRepo`, `outlineFile`, `loadIndex`, and `saveIndex`.

## License

MIT
