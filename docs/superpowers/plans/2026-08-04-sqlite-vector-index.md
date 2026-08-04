# SQLite vector index and incremental sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-request `.embedding` sidecar scans with a disposable per-journal SQLite/`sqlite-vec` index, incremental Markdown indexing, single-worker priority scheduling, and asynchronous Git sync.

**Architecture:** Markdown remains the Git-tracked source of truth. A per-journal SQLite database stores searchable metadata and a `sqlite-vec` virtual table; it is excluded from Git and rebuilt by migration when needed. All MCP processes share one OS-user embedding worker through the existing Unix socket, while SQLite WAL handles concurrent readers and short writer transactions.

**Tech Stack:** TypeScript/CommonJS, Node 24 `node:sqlite`, `sqlite-vec`, Jest, existing MCP SDK and Unix-socket embedding worker.

## Global Constraints

- Keep Markdown as the only canonical journal content.
- Keep exactly one embedding worker per OS user and one active inference at a time.
- Do not retain runtime `.embedding` fallback after successful migration.
- Do not run embedding inference inside a SQLite write transaction.
- Keep SQLite files out of journal Git history.
- Preserve the existing MCP tool names and result contracts.
- Keep secrets and journal content out of timing/logging output.

---

### Task 1: Add SQLite/vector runtime and schema

**Files:** Modify `package.json` and `package-lock.json`; create `src/index-db.ts` and `test/index-db.test.ts`.

**Interfaces:** `openJournalIndex(dataPath: string): JournalIndexDb`; `JournalIndexDb.upsert(entry: IndexedEntry): void`; `JournalIndexDb.removeByPath(entryPath: string): void`; `JournalIndexDb.search(vector: number[], options: IndexSearchOptions): SearchResult[]`; `JournalIndexDb.getSourceMtime(entryPath: string): number | null`.

- [ ] Add `sqlite-vec@^0.1.9` with `npm install sqlite-vec@^0.1.9`.
- [ ] Write a failing test that opens an isolated temporary database, upserts two 384-dimensional vectors, filters by section, and returns the nearest entry first.
- [ ] Run `npx jest test/index-db.test.ts --runInBand` and verify the failure is caused by the missing database module.
- [ ] Implement `src/index-db.ts` with `DatabaseSync` from `node:sqlite`, `sqlite-vec` loading, WAL, a 5-second busy timeout, `entries`, `vec_entries`, and `index_state` tables. Store vectors as `Buffer.from(new Float32Array(vector).buffer)` and keep write transactions short.
- [ ] Run `npx jest test/index-db.test.ts --runInBand` and verify it passes.

### Task 2: Implement one-time sidecar migration

**Files:** Create `src/index-migration.ts`; modify `src/index.ts`; create `test/index-migration.test.ts`.

**Interfaces:** `migrateLegacyIndex(options: MigrationOptions): Promise<MigrationResult>`; `main()` recognizes `migrate-index`.

- [ ] Write failing tests for valid sidecar import, missing sidecar recomputation through an injected embedding service, invalid vector dimension recomputation, atomic replacement, and sidecar deletion only after complete verification.
- [ ] Run `npx jest test/index-migration.test.ts --runInBand` and verify the expected missing-module failure.
- [ ] Implement a temporary-database migration. Scan Markdown once, read legacy sidecars only inside this command, validate path/timestamp/text/sections/vector dimension, compute replacements through the existing `EmbeddingService`, verify row count and every source path, atomically rename the temporary database, then remove sidecars and add SQLite/WAL files to Git excludes.
- [ ] Run `npx jest test/index-migration.test.ts --runInBand` and verify it passes.

### Task 3: Replace SearchService sidecar reads with incremental SQLite indexing

**Files:** Modify `src/search.ts`, `src/server.ts`, `src/journal.ts`, and `src/embeddings.ts`; modify `test/search.test.ts`, `test/server.test.ts`, and `test/journal.write.test.ts`.

**Interfaces:** `SearchService.backfill()` indexes only missing/changed rows; `SearchService.backfillPaths(paths)` indexes only supplied paths; `SearchService.indexPath(path)` indexes one Markdown file; `SearchService.removePath(path)` removes one index row.

- [ ] Write failing tests proving search does not call sidecar loading and unchanged files are skipped.
- [ ] Run `npx jest test/search.test.ts --runInBand` and verify the failure is caused by the current sidecar implementation.
- [ ] Implement incremental indexing by comparing Markdown mtime with `index_state`, reading changed Markdown, generating passage embeddings through the shared worker, and upserting changed paths.
- [ ] Replace semantic search with one query embedding plus `sqlite-vec` KNN and section filters. Replace recent listing with SQL timestamp ordering. Keep `read_journal` reading Markdown.
- [ ] Move legacy sidecar parsing exclusively into `index-migration.ts`; remove runtime `EmbeddingService.loadEmbedding/saveEmbedding` and update tests.
- [ ] Run `npx jest test/search.test.ts test/server.test.ts test/journal.write.test.ts --runInBand` and verify it passes.

### Task 4: Make embedding worker single-concurrency with query priority

**Files:** Modify `src/embedding-worker.ts`; modify `test/embedding-worker.test.ts`.

- [ ] Write a failing queue-order test that blocks one passage inference, enqueues another passage and a query, releases the first inference, and asserts query-before-passage with no overlapping fake-engine calls.
- [ ] Run `npx jest test/embedding-worker.test.ts --runInBand` and verify it fails because the queue is FIFO.
- [ ] Implement two in-memory queues with one drain loop. Classify query jobs as interactive and passage jobs as background. Select interactive jobs whenever waiting; never start a second job while one is active. Keep the socket protocol unchanged.
- [ ] Run `npx jest test/embedding-worker.test.ts --runInBand` and verify it passes.

### Task 5: Make write Git sync asynchronous

**Files:** Create `src/sync-launcher.ts`; modify `src/server.ts`, `src/index.ts`, and `src/git-sync.ts`; modify `test/server.test.ts`, `test/index.test.ts`, and `test/git-sync.test.ts`.

- [ ] Write failing tests that delay Git sync, assert `handleWrite` returns after local Markdown/index durability, and verify the detached child receives the selected `PRIVATE_JOURNAL_PATH` with ignored stdio.
- [ ] Run `npx jest test/server.test.ts test/index.test.ts --runInBand` and verify the failure is caused by `handleWrite` waiting for Git.
- [ ] Implement detached sync launch in `sync-launcher.ts`; pass `PRIVATE_JOURNAL_PATH`, inherit Git configuration, ignore stdio, and call `unref()`.
- [ ] Change `handleWrite` to perform local migration, Markdown write, and SQLite upsert before launching sync. It must not wait for network operations.
- [ ] Keep per-data-path Git serialization and add a regression test proving concurrent sync attempts do not overlap the Git critical section and a later run catches pending files.
- [ ] Run `npx jest test/server.test.ts test/index.test.ts test/git-sync.test.ts --runInBand` and verify it passes.

### Task 6: Document migration and concurrency

**Files:** Create `AGENTS.md`; modify `README.md` and `hooks/hooks.json`.

- [ ] Document `migrate-index`, the SQLite derived-index location, sidecar removal, single-worker semantics, incremental Git path handling, and async write durability.
- [ ] State that Markdown/Git is canonical, SQLite is disposable, embedding inference is one-at-a-time per OS user, and multiple Claude/Codex sessions share the worker and journal index.
- [ ] Validate with `node -e "JSON.parse(require('fs').readFileSync('hooks/hooks.json', 'utf8'))"` and `git diff --check`.

### Task 7: Full verification and migration smoke

**Files:** All changed source, tests, docs, and generated build output.

- [ ] Run `npx jest --runInBand` and record the complete result.
- [ ] Run `npm run build` and verify the generated runtime imports SQLite/vector support.
- [ ] Create a temporary Markdown fixture with legacy sidecars, run `node dist/index.js migrate-index` with `PRIVATE_JOURNAL_PATH` set to it, verify the SQLite database exists, sidecars are gone, and semantic search returns the expected entry.
- [ ] Inspect `git status --short`, `git diff --stat`, and `git diff --check` before any completion claim.
