# created_at YAML Front Matter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** write_journal이 caller가 제공한 의미 있는 title을 저장하게 하고, YAML front matter의 created_at 전환과 data revision 1 -> 2 migration을 구현하며, SQLite 파생 파일이 Git에 올라가지 않게 한다.

**Architecture:** src/journal.ts가 YAML front matter renderer/parser를 소유한다. stage 기반 data migration이 기존 Markdown을 변환하고 MigrationManager.run()은 migration 적용 여부를 반환해 server와 sync가 필요한 경우에만 전체 index backfill을 실행한다. GitSync는 SQLite/WAL/SHM을 exclude하고 이미 추적된 파일은 index에서만 제거한다.

**Tech Stack:** TypeScript, Node.js, yaml, Jest, SQLite WAL, Git.

## Global Constraints

- 새 front matter에는 title, created_at만 둔다.
- created_at은 UTC ISO 8601 문자열이다.
- write_journal.title은 trim 후 비어 있지 않아야 한다.
- legacy date와 numeric timestamp는 transition read/migration에만 허용한다.
- .private-journal-version.json은 Git에 유지하고 SQLite/WAL/SHM은 로컬 파생물로 둔다.
- migration 실패 시 stage만 폐기하고 원본을 변경하지 않는다.
- SQLite index schema 컬럼과 list/search 응답 필드명은 이번 작업에서 바꾸지 않는다.
- 사용자가 요청하기 전에는 commit/push하지 않는다.

---

### Task 1: YAML front matter renderer/parser

**Files:** package.json, package-lock.json, src/journal.ts, src/search.ts, src/migration/index/001-sidecar-to-sqlite.ts, test/journal.format.test.ts

**Interfaces:**
- renderEntry(sections: JournalSections, title: string, when: Date): string
- renderFrontmatter(title: string, createdAt: string): string
- parseFrontmatter(md): { title: string; created_at: string; timestamp: number }
- 내부 index의 date와 timestamp는 created_at에서 계산한 값을 계속 사용한다.

- [x] **Step 1: YAML 직접 의존성 추가**
Run: npm install yaml
Verify: npm ls yaml --depth=0

- [x] **Step 2: failing tests 작성**
test/journal.format.test.ts에서 renderer 결과의 YAML block을 YAML.parse로 읽어 supplied title과 created_at이 있는지 확인하고 date/timestamp가 없는지 검증한다. 새 parser가 created_at을 epoch timestamp로 계산하는 테스트와 legacy date/timestamp를 읽는 transition 테스트도 추가한다.

- [x] **Step 3: RED 확인**
Run: npm test -- --runInBand test/journal.format.test.ts
Expected: 기존 renderer signature와 수동 front matter가 새 테스트를 실패시킨다.

- [x] **Step 4: 최소 구현**
src/journal.ts에서 import YAML from yaml을 사용한다. renderFrontmatter는 YAML.stringify({ title, created_at: createdAt })를 --- delimiter로 감싼다. renderEntry는 이를 재사용하고 기존 section 순서와 본문 trim 동작을 유지한다. parser는 YAML block을 한 번 parse하고 created_at을 우선 사용하며, 없으면 유효한 legacy date, 그 다음 numeric timestamp를 ISO 문자열로 정규화한다. 유효한 시각이 없을 때 기존 transition read 경로에는 빈 값과 0을 반환하고 strict migration 검증은 Task 3에서 담당한다.

- [x] **Step 5: GREEN 확인**
Run: npm test -- --runInBand test/journal.format.test.ts
Expected: formatter, parser, section order, path format tests pass.

### Task 2: MCP/OpenCode write title 필수화

**Files:** src/journal.ts, src/server.ts, opencode-plugin.mjs, test/journal.write.test.ts, test/server.test.ts, test/opencode-plugin.test.ts, test/e2e.manual.test.ts

**Interfaces:**
- JournalManager.write(sections, title, when?): Promise<string>
- WriteJournalArgs = { title: string; content: string; section?: JournalSection }
- MCP와 OpenCode 모두 title: z.string().trim().min(1)을 required field로 노출한다.

- [x] **Step 1: failing tests 작성**
JournalManager가 caller title을 파일에 저장하는 테스트, PrivateJournalServer.handleWrite({ title: blank, content: x })가 Journal title must not be empty.를 반환하는 테스트, MCP schema에 title이 required인지 확인하는 테스트를 추가한다. OpenCode 실제 실행과 delegation fixture에도 title을 넣고 handler가 동일 값을 받는지 assert한다.

- [x] **Step 2: RED 확인**
Run: npm test -- --runInBand test/journal.write.test.ts test/server.test.ts test/opencode-plugin.test.ts
Expected: write signature와 schema가 없어서 실패한다.

- [x] **Step 3: 최소 구현**
handleWrite에서 title을 trim한 뒤 빈 문자열을 거부하고 journal.write(sections, title)로 전달한다. MCP inputSchema와 OpenCode args에 required title을 추가하고 설명에도 의미 있는 title을 호출자가 제공한다고 명시한다. 기존 fixture와 manual E2E 호출에 title을 추가한다.

- [x] **Step 4: GREEN 확인**
Run: npm test -- --runInBand test/journal.write.test.ts test/server.test.ts test/opencode-plugin.test.ts

### Task 3: data revision 1 -> 2와 migration-aware reindex

**Files:** Create src/migration/data/001-frontmatter-created-at.ts. Modify src/migrations.ts, src/server.ts, src/index.ts, test/migrations.test.ts, test/server.test.ts. Create test/data-migration.test.ts.

**Interfaces:**
- frontmatterCreatedAtMigration: Migration with from 1 and to 2.
- CURRENT_DATA_VERSION = 2.
- MigrationManager.run(): Promise<boolean> returns true only after a migration is activated.
- server initialize와 runSync는 migrated === true일 때만 전체 search.backfill()을 실행한다.

- [x] **Step 1: failing migration tests 작성**
test/data-migration.test.ts에 legacy date 우선, invalid/missing date일 때 numeric timestamp fallback, title/body 보존, date/timestamp 제거, embedding 제거, version 2 기록, 복구 불가능한 front matter의 original 보존을 고정한다. run()은 current version에서 false, migration 적용 후 true인지 테스트한다.

- [x] **Step 2: RED 확인**
Run: npm test -- --runInBand test/data-migration.test.ts test/migrations.test.ts
Expected: default registry가 비어 있고 current version이 1이라 실패한다.

- [x] **Step 3: migration 구현**
stage 아래 .md를 재귀적으로 walk한다. 각 file의 YAML front matter에서 title을 보존하고 valid date를 먼저, valid numeric timestamp를 다음으로 선택해 new Date(...).toISOString()으로 정규화한다. renderFrontmatter(title, createdAt)와 closing delimiter 이후의 원본문을 stage에 write하고 상대 Markdown path를 invalidatedMarkdownPaths로 반환한다. 둘 다 invalid하면 상대 경로를 포함한 DataVersionError를 throw한다. src/migrations.ts의 기본 registry에 migration을 등록하고 run() 반환값을 구현한다.

- [x] **Step 4: reindex 구현**
runSync와 PrivateJournalServer.initialize에서 migrated를 받고, search.needsInitialBackfill() 또는 migrated이면 search.backfill(), 아니면 기존 pulled paths만 backfillPaths()한다. migration은 derived SQLite를 직접 수정하지 않는다.

- [x] **Step 5: GREEN 확인**
Run: npm test -- --runInBand test/data-migration.test.ts test/migrations.test.ts test/server.test.ts

### Task 4: SQLite/WAL/SHM Git 추적 제거

**Files:** src/git-sync.ts, test/git-sync.test.ts

- [x] **Step 1: failing regression test 작성**
임시 Git repo에 SQLite, -wal, -shm, .private-journal-version.json을 모두 commit한 뒤 new GitSync(dir, remotePath).ensureRepo()를 호출한다. git ls-files에서 SQLite 세 파일은 없어지고 version file은 남으며, 세 로컬 파일과 .git/info/exclude 규칙은 유지되는지 assert한다.

- [x] **Step 2: RED 확인**
Run: npm test -- --runInBand test/git-sync.test.ts
Expected: 현재는 .embedding만 untrack하므로 SQLite가 남는다.

- [x] **Step 3: 최소 구현**
기존 embedding 전용 cleanup을 derived-file cleanup으로 확장한다. git ls-files -z --로 *.embedding, SQLite 본체, WAL, SHM을 찾고 tracked path가 있을 때 git rm --cached --quiet -- paths를 실행한다. 작업 트리 파일은 삭제하지 않는다. 기존 best-effort logging과 exclude append 로직은 유지한다.

- [x] **Step 4: GREEN 확인**
Run: npm test -- --runInBand test/git-sync.test.ts

### Task 5: 문서와 최종 검증

**Files:** README.md, stale test fixtures, docs/superpowers/specs/2026-08-06-created-at-yaml-design.md

- [x] **Step 1: README 반영**
write_journal의 required title/content/optional section 계약, title/created_at front matter, version file은 sync되고 SQLite/WAL/SHM은 local derived file이라는 경계를 문서화한다.

- [x] **Step 2: stale call site 검색**
Run: rg -n "handleWrite\\(|write_journal\\.execute|renderEntry\\(" src test opencode-plugin.mjs README.md
모든 call에 required title을 추가하고 모든 renderEntry call에 title을 추가한다.

- [x] **Step 3: required verification**
다음 명령을 순서대로 실행한다.

    npm test -- --runInBand
    npm run build
    git diff --check

Expected: Jest zero failures, build exit 0, diff check no output.

- [x] **Step 4: scope inspection**
git status --short, git diff --stat, 그리고 journal/migrations/GitSync/server/index 및 관련 test/docs의 focused diff를 확인한다. 승인한 변경만 남았는지 확인하고 worktree는 uncommitted 상태로 둔다.
