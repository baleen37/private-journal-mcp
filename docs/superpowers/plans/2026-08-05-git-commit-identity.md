# Git Commit Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 자동 Git 동기화 커밋에 `journal <journal@localhost>` 기본 identity를 적용하고 `GIT_NAME`/`GIT_EMAIL` 환경변수로 덮어쓸 수 있게 한다.

**Architecture:** `src/git-sync.ts`에 순수 identity resolver를 추가하고, 모든 Git subprocess 환경을 만들 때 resolver 결과를 병합한다. `GIT_NAME`/`GIT_EMAIL`을 해석한 뒤 author와 committer에 같은 값을 적용한다.

**Tech Stack:** TypeScript, Node.js `child_process.execFile`, Jest.

## Global Constraints

- Markdown 파일과 Git이 저널의 canonical source다.
- Git pull/commit/push는 detached background sync가 수행한다.
- 변경 시 `npm test -- --runInBand`, `npm run build`, `git diff --check`를 실행한다.
- 소스 변경은 author/committer identity와 그 검증에만 한정한다.

---

### Task 1: Git identity resolver

**Files:**
- Modify: `src/git-sync.ts`
- Test: `test/git-sync.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `NodeJS.ProcessEnv`
- Produces: `resolveGitIdentityEnv(env): Pick<NodeJS.ProcessEnv, 'GIT_AUTHOR_NAME' | 'GIT_AUTHOR_EMAIL' | 'GIT_COMMITTER_NAME' | 'GIT_COMMITTER_EMAIL'>`

- [x] **Step 1: Write the failing tests**

Add tests for `resolveGitIdentityEnv({})` returning `journal` and `journal@localhost` for both author and committer, and for explicit `GIT_NAME`/`GIT_EMAIL` variables being mapped to both fields.

- [x] **Step 2: Run the focused test and verify it fails**

Run: `npm test -- --runInBand test/git-sync.test.ts`

Expected: FAIL because `resolveGitIdentityEnv` does not exist yet.

- [x] **Step 3: Implement the minimal resolver and wire it into Git subprocesses**

Use `journal` and `journal@localhost` only when `GIT_NAME` and `GIT_EMAIL` are absent or blank. Map the resolved values to both author and committer Git variables. Merge the result into `gitEnv` after `process.env` so the resolver controls defaults while explicit public variables remain supported.

- [x] **Step 4: Run the focused test and verify it passes**

Run: `npm test -- --runInBand test/git-sync.test.ts`

Expected: PASS.

- [x] **Step 5: Document the environment variables**

Add a short README subsection under Git Sync explaining the default identity and the `GIT_NAME`/`GIT_EMAIL` override variables. State that a GitHub-linked author email is required for contribution attribution.

- [x] **Step 6: Run the full verification suite**

Run: `npm test -- --runInBand`, `npm run build`, and `git diff --check`.

Expected: all tests pass, build succeeds, and `git diff --check` emits no output.
