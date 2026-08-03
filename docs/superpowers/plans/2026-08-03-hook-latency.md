# Hook latency fix implementation plan

> **For the implementation agent:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to execute this plan task-by-task.

**Goal:** Make the private-journal SessionStart sync return quickly while preserving Git sync correctness, and remove the redundant fetch in the sync path.

**Architecture:** `runSync()` performs the initial pull, then tells `GitSync.commitAndPush()` that the remote was already checked. A new `sync --background` launcher starts the existing foreground sync in a detached child with ignored stdio. The bundled hook and manual documentation invoke this launcher mode.

**Tech Stack:** TypeScript, Node.js `child_process.spawn`, Jest, Git fixture integration tests.

### Task 1: Add regression tests for fetch reuse

**Files:** `test/git-sync.test.ts`, `test/index.test.ts`

1. Add a Git fixture test proving `remoteAlreadyPulled` does not pull again when there is nothing local to commit.
2. Add a Git fixture test proving a local commit still pulls before pushing when the option is set.
3. Extend the `runSync()` mock assertion to require the explicit option after the initial pull.
4. Run the targeted tests and confirm they fail before implementation.

### Task 2: Implement the duplicate-fetch change

**Files:** `src/git-sync.ts`, `src/index.ts`

1. Add an optional `remoteAlreadyPulled` commit option.
2. Skip the preflight fetch and no-op pull only when that option is true.
3. Keep the pull-before-push loop unchanged for local commits.
4. Pass the option from `runSync()` after its initial pull.
5. Run the targeted tests and confirm they pass.

### Task 3: Add detached background sync

**Files:** `src/index.ts`, `test/index.test.ts`

1. Add a `sync --background` branch that spawns the same executable with `sync`, ignores all stdio, detaches, and unreferences the child.
2. Test that background mode does not execute `runSync()` in the parent and calls `unref()`.
3. Run the index and GitSync tests.

### Task 4: Update hook and documentation

**Files:** `hooks/hooks.json`, `README.md`

1. Change the bundled SessionStart command to `sync --background`.
2. Update the manual hook example and explain that the hook returns while sync continues in the background.
3. Validate JSON and search the docs for stale synchronous hook commands.

### Task 5: Verify the release artifact

1. Run the full Jest suite and TypeScript build.
2. Inspect generated `dist/` changes and the final diff for scope.
3. Run the installed launcher smoke test and the copied clean-journal sync smoke test.
4. Commit the implementation with a focused message and record the verification evidence.
