# Git 동기화 원자성 개선 설계

날짜: 2026-07-28

## 목표

저널 항목을 쓰는 순간 원격 `main`에 원자적으로 반영한다. 여러 컴퓨터에서 동시에
쓰는 상황에서도 항목이 유실되지 않고, repo가 복구 불가능한 상태로 남지 않는다.

## 배경

`GitSync`는 이미 대부분 구현되어 있다. 이 설계는 새 기능을 만드는 것이 아니라
기존 구현의 원자성 구멍을 메운다.

이미 동작하는 것:

- `ensureRepo()` — 원격이 비었으면 `init`+`remote add`, 내용이 있으면 clone 후 로컬과 병합
- `pull()` — `pull --rebase --autostash`, 충돌 시 `resolveRebaseConflicts()`
- `commitAndPush()` — `add -A` → `commit` → (`pull` → `push`) 재시도
- 충돌 해결 — frontmatter `timestamp`가 큰 쪽 승리 (`chooseConflictWinner`)
- `PRIVATE_JOURNAL_GIT_REMOTE` 환경변수로 remote 설정
- SessionStart 훅에서 `sync` 서브커맨드 실행

## 저장 구조 (확인된 사실)

데이터 디렉터리는 날짜별 디렉터리 안에 개별 `.md` + `.embedding` 쌍으로 구성된다.
**중앙 인덱스 파일이나 DB가 없다.** 쓰기 지점은 `journal.ts:83`의
`writeFile(mdPath, ...)` 한 곳뿐이다. 구조적으로 append-only이므로 여러 기기가
같은 인덱스를 갈아쓰는 문제는 존재하지 않는다.

현재 규모: `.md` 943건 4MB, `.embedding` 943건 11MB (전체 15MB).

## 채택하지 않은 것

**주기적 pull / 인터벌 / 백그라운드 데몬.** 동기화는 쓰기 시점에만 일어난다.
검색은 세션 시작 시점 스냅샷을 본다. 다른 기기의 변경은 다음 세션이나 다음 쓰기
시점에 반영된다. 저널이 append-only라 stale한 검색 결과가 실질적 문제를 만들지
않는다.

**충돌로 밀려난 버전 보존.** 파일명에 마이크로초가 포함되므로 두 기기가 같은
파일명을 만들 확률이 사실상 없다. `.conflict-*.md` 보존은 일어나지 않는 사건에
대비해 파일을 쌓는 일이다.

**`.embedding` 커밋 제외.** 검토했으나 채택하지 않는다. repo가 73% 작아지고
충돌 원인이 사라지지만, 새 기기에서 943건 백필이 돌아야 검색이 가능해진다.
즉시 검색 가능한 편의를 택하고 `.embedding` 충돌 처리를 유지한다.

## 변경 범위

### 1. `handleWrite`를 await로 (`src/server.ts`)

현재 `void this.git.commitAndPush(...)`는 fire-and-forget이다. push 완료를
기다리지 않으므로 세션이 종료되면 커밋이 로컬에만 남는다.

`await`로 바꾼다. 실패는 삼켜서 저널 쓰기 자체는 성공시킨다 — 커밋은 로컬에
남아 있고 다음 쓰기나 SessionStart가 밀어낸다.

### 2. 네트워크 작업에만 타임아웃 (`src/git-sync.ts`)

`await`로 바꾸면 원격 장애가 저널 쓰기를 붙잡는다. 상한이 필요하다.

**타임아웃은 네트워크 명령에만 적용한다.** `ls-remote`, `push`, `fetch`가 대상이며
`execFile`의 `timeout` 옵션(기본 10초, `PRIVATE_JOURNAL_GIT_TIMEOUT_MS`로 조정)을
쓴다.

로컬 rebase와 충돌 해결에는 **타임아웃을 걸지 않는다.** rebase 중간에 손을 떼면
repo가 rebase 진행 중 상태로 남고, 이후 모든 `commit`이 실패해서 저널이 영구히
올라가지 않는 상태가 된다. 로컬 작업은 네트워크와 달리 무한정 걸리지 않는다.

### 3. rebase 잔여 상태 복구 (`src/git-sync.ts`)

`commitAndPush()` 진입 시 `hasRebaseInProgress()`를 확인한다.

1. 진행 중이면 `resolveRebaseConflicts()`로 해결을 시도한다
2. 그래도 남아 있으면 `git rebase --abort`로 깨끗한 상태로 되돌린다

커밋은 로컬에 남으므로 데이터는 잃지 않는다. 이것이 "저널이 계속 안 올라가는
상태"를 막는 안전망이다. 기존 `logUnresolvedRebaseState()`는 로그만 남기고
복구하지 않으므로 이 단계가 필요하다.

### 4. 기기 내 동시성: 파일 록 (`src/git-sync.ts`)

같은 기기의 여러 Claude Code 세션이 각자 MCP 서버를 띄우면 같은 repo를 동시에
건드린다. git `index.lock` 충돌이 나고, 더 나쁘게는 한쪽의 rebase 중간 상태를
다른 쪽이 깨뜨린다.

`withLock()`으로 `pull`과 `commitAndPush`를 감싼다.

- 데이터 디렉터리에 `.private-journal-sync.lock`을 `wx` 플래그로 원자적 생성
- 파일에는 pid와 획득 시각을 기록
- **이미 잡혀 있으면 기다리지 않고 조용히 skip.** 커밋되지 않은 항목은 다음
  sync의 `git add -A`가 쓸어담으므로 유실이 없다
- 획득 시각이 2분을 넘긴 stale 록은 탈취 (프로세스가 죽어 남은 경우)
- 록 파일은 `.gitignore`에 추가

### 5. 기기 간 동시성: push 재시도 확대 (`src/git-sync.ts`)

**파일 록은 기기 간에는 무의미하다.** 서로 다른 컴퓨터는 파일시스템이 다르므로
서로의 록을 볼 수 없다. 기기 간 동시성을 보장하는 것은 록이 아니라 git의
rebase와 push 재시도다.

현재 재시도는 2회(`for attempt < 2`)로, 기기가 여러 대면 push 경쟁에 부족하다.
5회로 늘리고 지수 백오프(100ms, 200ms, 400ms, 800ms)를 넣는다.

### 6. `.embedding` 바이너리 선언 (`.gitattributes`)

`.embedding`은 바이너리다. git이 텍스트로 오판하면 rebase가 내용을 병합하려
시도해서 벡터 파일을 깨뜨린다.

데이터 repo 루트에 `.gitattributes`를 생성하고 `*.embedding binary`를 넣는다.
`ensureRepo()`가 repo를 초기화할 때 이 파일을 함께 만든다. 이렇게 하면 충돌 시
자동 병합을 시도하지 않고 항상 한쪽을 통째로 고른다.

`.embedding` 충돌은 기존 방식대로 처리한다 — `resolveRebaseConflicts()`가
`--ours`로 잡고 넘어가며, 대응 `.md`가 교체된 경우 삭제해서 재생성을 유도한다.

### 7. repo 준비 문서화 (`README.md`)

코드 변경 없음. 설정은 이미 환경변수로 가능하다.

```bash
gh repo create baleen37/private-journal-vault --private
export PRIVATE_JOURNAL_GIT_REMOTE=git@github.com:baleen37/private-journal-vault.git
```

빈 repo면 `ensureRepo`가 `init`+`remote add`, 내용이 있으면 clone 후 로컬과
병합한다. 둘 다 이미 구현되어 있다.

## 충돌 처리 규칙 (기존 유지)

- 파일명에 마이크로초가 포함되어 서로 다른 항목은 충돌하지 않고 양쪽에 공존한다
- 같은 파일명이면 frontmatter `timestamp`가 큰 쪽이 이긴다
- `timestamp`가 같으면 로컬이 이긴다
- `.embedding` 충돌은 `--ours`로 해결하고, 대응 `.md`가 교체되면 삭제해 재생성한다

## 테스트

`test/git-sync.test.ts`의 기존 패턴을 따른다.

**핵심 검증 — 여러 기기 동시 쓰기 재현:** 두 개의 클론에서 각각 항목을 쓰고
번갈아 push한다. 양쪽 항목이 모두 살아남고 rebase가 깨끗하게 끝나는지 확인한다.

그 외:

- `handleWrite`가 push 완료를 기다린다 (await 검증)
- 원격이 응답하지 않을 때 타임아웃 후에도 저널 쓰기는 성공한다
- 타임아웃이 rebase 진행 중 상태를 남기지 않는다
- rebase 진행 중 상태로 진입하면 복구하거나 abort한다
- 록이 잡혀 있으면 sync를 skip한다
- stale 록은 탈취한다
- skip된 항목이 다음 sync에서 커밋된다
- 록 파일이 커밋되지 않는다
- push 경쟁 시 재시도로 성공한다
- `.embedding` 충돌이 파일을 깨뜨리지 않는다
- `ensureRepo`가 `.gitattributes`를 생성한다

## 파일별 변경 요약

| 파일 | 변경 |
|---|---|
| `src/server.ts` | `handleWrite`의 `void` → `await` |
| `src/git-sync.ts` | 네트워크 타임아웃, rebase 복구, `withLock()`, 재시도 5회+백오프, `.gitattributes` 생성 |
| `.gitignore` | 록 파일 추가 |
| `README.md` | repo 생성/설정 문서화, 동기화 시점 명확화 |
| `test/git-sync.test.ts` | 위 시나리오 |
