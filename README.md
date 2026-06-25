# private-journal-mcp

An MCP server that stores journal entries in local files and searches them semantically with multilingual embeddings.
Search and embedding inference run locally; the embedding model is downloaded and cached once on first use.
Optionally, entries can be auto-synced to a Git remote.

## Tools

- `write_journal`
  - Takes one or more of the six sections (`reflections`, `observations`, `project_notes`, `user_context`, `technical_insights`, `world_knowledge`) and stores an entry.
- `search_journal`
  - Performs semantic search with `query`.
  - Optional args: `limit`, `sections`
- `read_journal`
  - Reads a full individual Markdown entry by `path`.
- `list_journal`
  - Lists recent entries.
  - Optional args: `limit`, `days`

## Storage Locations

### Journal data

Priority order:

1. `PRIVATE_JOURNAL_PATH`
2. `$XDG_DATA_HOME/private-journal`
3. `~/.local/share/private-journal`

### Model cache

Priority order:

1. `$XDG_CACHE_HOME/private-journal/models`
2. `~/.cache/private-journal/models`

The default embedding model is `Xenova/multilingual-e5-small`.

## Install / Build

```bash
npm install
npm run build
```

Run locally:

```bash
node dist/index.js
```

The `sync` subcommand exits as a no-op when no Git remote is configured.

```bash
node dist/index.js sync
```

## Registering with Claude MCP

```bash
claude mcp add private-journal -- node /absolute/path/to/private-journal-mcp/dist/index.js
```

## Git Sync (optional)

Git sync is enabled only when `PRIVATE_JOURNAL_GIT_REMOTE` is set.

```bash
export PRIVATE_JOURNAL_GIT_REMOTE="git@github.com:youruser/my-journal.git"
```

Recommended prerequisites:

- You must already be authenticated for that remote via `gh auth login` or equivalent Git credentials.

Behavior:

- Right after a `write_journal` save, it attempts `commit + pull --rebase + push` on a best-effort basis.
- `node dist/index.js sync` handles `pull` and pushing any pending commits before a session starts.

## SessionStart hook example

`~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/private-journal-mcp/dist/index.js sync"
          }
        ]
      }
    ]
  }
}
```

## Conflict Handling

- Distinct entries mostly coexist automatically because filenames include a microsecond suffix.
- When two entries share a filename, the one with the larger frontmatter `timestamp` wins.
- If the `timestamp` is identical, the local version takes precedence.
- The `.embedding` file may be regenerated based on the adopted Markdown.
