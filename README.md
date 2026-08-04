# private-journal-mcp

An MCP server that stores journal entries in local files and searches them semantically with multilingual embeddings.
Search and embedding inference run locally; the embedding model is downloaded and cached once on first use.
Optionally, entries can be auto-synced to a Git remote.

## Tools

- `write_journal`
  - Stores an entry from `content`.
  - Optional arg: `section` (`reflections`, `observations`, `project_notes`, `user_context`, `technical_insights`, `world_knowledge`)
  - `section` defaults to `observations`.
- `search_journal`
  - Performs semantic search over stored entries.
  - Required arg: `query`
  - Optional args: `limit`, `section`
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

The first upgrade from the legacy `.embedding` sidecars requires a one-time
index migration. It creates the SQLite vector index, verifies it, and removes
sidecars only after success:

```bash
node dist/index.js migrate-index
```

Without a Git remote, the `sync` subcommand still runs local data migrations and
incrementally indexes changed Markdown files, but does not perform Git operations.

```bash
node dist/index.js sync
```

## Install as a Plugin (recommended)

This repo is a plugin for both Claude Code (`.claude-plugin/plugin.json`) and Codex
(`.codex-plugin/plugin.json`). Installing it registers the MCP server **and** the
SessionStart sync hook in one step — no manual `settings.json`/`config.toml` edits.
The MCP server is declared inline in each manifest's `mcpServers` field (not a root
`.mcp.json`, which would auto-load as a project-scope server). It resolves the plugin's
own install path via `${CLAUDE_PLUGIN_ROOT}` (Claude Code) / a `./bin` relative path
with `cwd` (Codex). The bundled `hooks/hooks.json` resolves paths the same way.

Build first so `dist/` exists, then install:

```bash
npm install && npm run build
```

Claude Code:

```bash
/plugin install /absolute/path/to/private-journal-mcp
```

When Claude Code enables the plugin, it asks for an optional **Git remote**.
Enter a remote URL to enable Git sync, or leave it blank for local-only storage.
To change it later, open the plugin configuration dialog and select
`private-journal-mcp`.

Codex:

```bash
codex plugin install /absolute/path/to/private-journal-mcp
```

OpenCode:

Published package, in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["private-journal-mcp"]
}
```

Local checkout:

```bash
npm install && npm run build
mkdir -p .opencode/plugins
ln -sfn "$(pwd)/opencode-plugin.mjs" .opencode/plugins/private-journal-mcp.js
```

The symlink keeps the plugin's relative `dist/` import rooted at the checkout.
OpenCode automatically loads plugins from the project `.opencode/plugins/`
directory; use `~/.config/opencode/plugins/` for a global local plugin instead.

The plugin exposes `write_journal`, `search_journal`, `read_journal`, and
`list_journal` as native OpenCode tools. It uses the same local data path and
Git remote environment variables as the MCP server. Set
`PRIVATE_JOURNAL_GIT_REMOTE` for Git sync; leave it unset for local-only storage.

### Manual MCP registration (without the plugin)

```bash
claude mcp add private-journal -- node /absolute/path/to/private-journal-mcp/dist/index.js
```

## Git Sync (optional)

Claude Code passes this setting to the plugin as
`CLAUDE_PLUGIN_OPTION_GIT_REMOTE`. Existing Codex and manual MCP setups can
continue to use `PRIVATE_JOURNAL_GIT_REMOTE`:

```bash
export PRIVATE_JOURNAL_GIT_REMOTE="git@github.com:youruser/my-journal.git"
```

Recommended prerequisites:

- You must already be authenticated for that remote via `gh auth login` or equivalent Git credentials.
- Do not put credentials or tokens in the remote URL. Use SSH or a Git credential
  helper instead.

### Setting up the remote

Create a private repo and point the server at it:

```bash
gh repo create <your-account>/private-journal-vault --private
export PRIVATE_JOURNAL_GIT_REMOTE=git@github.com:<your-account>/private-journal-vault.git
```

If the remote is empty, the data directory is initialized in place (and stays
silent — no error — on the first sync). If the remote already has entries, it
is cloned and merged with whatever is already local.

Behavior:

- A `write_journal` save returns after Markdown and the SQLite index are durable.
  Git pull/commit/rebase/push runs in a detached background process.
- Push is retried up to 5 times (`PUSH_RETRY_LIMIT`) with exponential backoff
  (100/200/400/800ms), which lets several machines writing at once converge
  without losing entries.
- Network commands (`fetch`, `push`, `ls-remote`, `clone`) time out after 10s,
  tunable via `PRIVATE_JOURNAL_GIT_TIMEOUT_MS`. Local rebase is never
  interrupted — cutting a rebase short would leave the repo unable to commit.
- If a previous run left an interrupted rebase, the next sync resolves it, or
  aborts it, or as a last resort force-cleans unreadable rebase state. Local
  commits are preserved either way.
- Within one machine, sync is serialized by a `.private-journal-sync.lock`
  file in the data directory. If another session already holds it, this run
  is skipped (not queued); the next run picks up whatever is pending. Locks
  older than 120s are considered stale and stolen.
- All Claude Code and Codex sessions for one OS user share one embedding worker
  and one active model inference. Query embeddings have priority over queued
  passage backfill. SQLite WAL allows concurrent index readers and short writes.
- Markdown and Git remain canonical. SQLite is disposable derived state at
  `.private-journal-index.sqlite`; its WAL/SHM files are excluded from Git.
- A missing or incomplete SQLite index is backfilled from Markdown once. Once
  it is complete, startup processes only Git-reported changed paths.
- Reads (`search_journal`, `list_journal`, `read_journal`) do not pull. A
  session sees the snapshot from when it started, plus anything it wrote
  itself. Changes from other machines arrive at the next session start or
  the next write.
- `node dist/index.js sync` pulls and pushes any pending commits before a
  session starts.

### Data-format compatibility

When the same journal is used on multiple computers, an app that upgrades the
journal data format records the new version in the journal. Older app versions
then stop before reading or writing and tell you to update, instead of risking
an incompatible change.

## SessionStart sync hook

When installed as a plugin, the SessionStart sync hook is registered automatically
(see `hooks/hooks.json`) — nothing to configure. Without a configured remote it
still runs local data migrations and incremental index backfill.

The hook uses `sync --background`, so SessionStart returns immediately while the
existing sync process continues in the background. To run the same sync in the
foreground, use `node dist/index.js sync`.

To wire it up manually instead, add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/private-journal-mcp/dist/index.js sync --background"
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
- The SQLite row for the adopted Markdown is regenerated from the source file.
- Legacy `.embedding` files are not part of runtime conflict handling; run
  `migrate-index` once to convert and remove them.
