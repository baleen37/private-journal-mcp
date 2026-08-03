# private-journal-mcp Hook Latency Design

## Goal

Remove redundant Git fetches from the SessionStart sync path and make the
SessionStart hook return immediately while the sync continues in a detached
background process.

## Scope

- Keep the initial pull, migration, backfill, local commit, and push semantics.
- Skip the second remote validation and no-op pull when the caller already
  completed the initial pull in the same sync operation.
- Preserve the pull-before-push step when a local commit was created.
- Add an explicit `sync --background` launcher mode that detaches the real
  `sync` process and closes its stdio before returning.
- Update the bundled hook manifest and manual hook documentation.
- Do not change journal data layout, Git conflict resolution, or MCP tool
  behavior.

## Design

`runSync()` will call `GitSync.commitAndPush()` with an explicit
`remoteAlreadyPulled` option after its initial `pull()`. In that mode,
`commitAndPush` skips its pre-commit remote version fetch. If the commit is a
no-op, it returns immediately because the caller has already pulled. If a
local commit exists, it retains the existing pull-before-push loop so concurrent
writers still rebase safely.

The launcher will recognize `sync --background`, spawn a detached child with
`stdin`, `stdout`, and `stderr` set to `ignore`, call `unref()`, and exit. The
child executes the existing synchronous `sync` path. The hook manifest will use
this mode, which works for both Claude Code and Codex without relying on
runtime-specific async hook fields.

## Error handling

- Background sync keeps the existing best-effort logging and Git timeout.
- A failed background sync cannot delay the client hook or surface as a
  SessionStart failure.
- Data-version incompatibility remains an error in foreground MCP writes and
  the existing sync implementation.

## Verification

- Unit test that `remoteAlreadyPulled` avoids the redundant fetch/no-op pull.
- Unit test that a local commit still performs pull-before-push.
- Unit test that `runSync()` passes the option after its initial pull.
- Launcher test that `sync --background` returns without inheriting stdio and
  starts the real sync child.
- Validate the hook manifest and manual README command.
- Run the full repository test suite, build, and an installed-plugin smoke test.
