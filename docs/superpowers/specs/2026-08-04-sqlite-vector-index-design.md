# SQLite vector index and incremental sync design

## Goal

Make `private-journal-mcp` search without reading every `.embedding` sidecar on each request, while keeping Markdown in Git as the only journal source of truth and keeping embedding inference single-process and single-concurrency.

## Scope

- Add a per-journal SQLite derived index using `node:sqlite` and `sqlite-vec`.
- Add one-time migration from existing `.embedding` sidecars into SQLite.
- Remove runtime sidecar fallback after migration succeeds.
- Re-index only new or changed Markdown files.
- Keep one user-scoped `EmbeddingWorker`; queued inference remains serialized.
- Prefer interactive query embeddings over background passage backfill jobs.
- Make Git commit/push asynchronous for `write_journal`.
- Keep Git synchronization scoped to the journal data path and safe for several Claude/Codex MCP processes.
- Document the concurrency contract in root `AGENTS.md`.

## Non-goals

- Do not store Markdown as the canonical content in SQLite.
- Do not run multiple embedding workers or parallel model inference.
- Do not add a durable job queue or a separate network daemon.
- Do not introduce ANN tuning beyond the `sqlite-vec` KNN table.

## Data model

Each journal data path owns one derived database at `<PRIVATE_JOURNAL_PATH>/.private-journal-index.sqlite`. The database and its WAL/SHM files are excluded from the journal Git repository.

The database contains:

- `entries`: path, timestamp, sections, excerpt, source mtime, and embedding version.
- `vec_entries`: `sqlite-vec` virtual table with one 384-dimensional vector per `entries.id`.
- `index_state`: source path, source mtime, and index version for incremental rebuild decisions.

Markdown files remain the source of truth. The SQLite database is disposable and can be rebuilt from Markdown plus the single embedding worker.

Revision ownership is target-specific: the journal data format keeps its existing
version metadata, while SQLite stores `schema_revision` in `index_meta`. Migration
implementations live under `src/migration/<target>/<NNN-name>.ts`; the exported
`from`/`to` values and persisted revision are authoritative over the filename.

## Migration

`migrate-index` creates a temporary database beside the target database. It reads existing sidecars only as one-time migration input, validates their metadata and vector dimensions, and recomputes missing or invalid vectors from Markdown through `EmbeddingService`.

The migration verifies that every Markdown file has a valid SQLite entry before atomically renaming the temporary database into place. Only after verification does it delete the old `.embedding` files and update Git excludes. A failed migration leaves the original sidecars untouched.

Normal runtime code does not read `.embedding` files after migration. A failed
migration may leave the legacy files in place for recovery, but that is not a
runtime fallback path.

## Runtime flow

### Search

1. Generate one query embedding through `EmbeddingBroker`.
2. Execute a `sqlite-vec` KNN query with section filters and the requested limit.
3. Return excerpt and metadata from `entries`.
4. Read the Markdown file only when `read_journal` is explicitly requested.

### Write

1. Run local data migration checks.
2. Write Markdown.
3. Generate one passage embedding through the shared worker.
4. Upsert the changed entry in a short SQLite transaction.
5. Spawn detached `sync` for Git pull, commit, and push.
6. Return after local Markdown and index durability, without waiting for the network.

### Git pull and background sync

`GitSync.pull()` already returns changed Markdown paths. The background sync passes those paths to the indexer, which deletes/rebuilds only affected rows. Deleted Markdown paths remove their SQLite rows. MCP startup and SessionStart use a full filesystem walk only when the SQLite index is missing or marked incomplete; a complete index processes only Git-reported paths. Explicit migration and index integrity rebuilds may also use a full walk.

## Concurrency

- One `EmbeddingWorker` per OS user owns model memory and processes one job at a time.
- Each MCP process connects to that worker through the existing private Unix socket.
- Query jobs have priority over background passage jobs. Priority selects the next queued job; it never interrupts an inference already running.
- Each journal path has one SQLite database. WAL mode permits concurrent readers; index writes happen in short transactions with a busy timeout.
- Embedding inference happens outside SQLite transactions.
- Git synchronization remains protected by the existing per-data-path lock. Local Markdown writes are durable before background sync starts. Concurrent syncs may skip when the lock is held; a later sync catches up pending files.

## Failure handling

- If embedding fails, Markdown remains saved and a later background index pass retries it.
- If SQLite is missing or corrupt, `migrate-index` rebuilds it from Markdown.
- If Git fails, the local Markdown and SQLite index remain usable and the next background/session sync retries Git.
- SQLite migration never deletes sidecars before the replacement database has passed its completeness check.

## Verification

- Migration imports valid legacy sidecars, recomputes invalid/missing vectors, atomically replaces the database, and removes sidecars only after success.
- Search executes vector KNN and does not call `loadEmbedding` or read sidecars.
- Incremental indexing updates only changed paths and removes deleted paths.
- Two worker clients share one worker PID and query jobs overtake queued background jobs without running inference concurrently.
- `write_journal` returns before a delayed Git sync completes while Markdown and SQLite are already durable.
- Several concurrent background syncs preserve all local Markdown files and do not create duplicate embedding workers.
