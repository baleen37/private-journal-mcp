# private-journal-mcp 운영 규칙

## 저장소와 revision

- Markdown 파일과 Git이 저널의 canonical source다.
- SQLite는 파생 검색 인덱스이며 `<PRIVATE_JOURNAL_PATH>/.private-journal-index.sqlite`에 둔다. `-wal`, `-shm` 파일도 파생물이다.
- 데이터 포맷 revision, SQLite index schema revision, embedding revision은 서로 다른 값으로 관리한다.
- migration 파일은 `src/migration/<target>/<NNN-name>.ts` 형식을 사용한다. 실행 순서는 파일명보다 migration의 `from`/`to`와 저장소 revision을 기준으로 한다.
- 기존 `.embedding`은 `index 0 -> 1` migration에서만 읽는다. migration 성공 후 삭제하며, runtime 검색·쓰기 경로에서는 읽지 않는다.

기존 저널을 처음 업그레이드할 때:

```bash
npm run build
node dist/index.js migrate-index
```

migration은 임시 SQLite DB를 만들고 모든 Markdown의 인덱싱을 검증한 뒤 교체한다. 실패하면 기존 sidecar를 보존한다. 최초 migration이나 schema revision 변경 시에는 해당 저널을 사용하는 MCP 세션을 잠시 종료하고 실행한다.

## 임베딩과 여러 세션

- OS 사용자당 `EmbeddingWorker` 프로세스 하나만 사용한다.
- 실제 모델 추론은 항상 한 번에 하나만 실행한다.
- query 임베딩은 대기 중인 passage backfill보다 우선하지만, 실행 중인 추론을 중단하지 않는다.
- 여러 Claude Code/Codex 세션은 같은 Unix socket worker를 공유한다.
- 각 MCP 프로세스는 같은 SQLite DB를 열고 WAL과 짧은 write transaction을 사용한다.
- 임베딩 계산은 SQLite transaction 밖에서 하고, 계산이 끝난 뒤 index row를 upsert한다.

## 쓰기와 Git 동기화

`write_journal`은 Markdown 저장과 SQLite index upsert가 끝나면 반환한다. Git pull/commit/push는 detached background sync가 수행한다.

- 동기화는 data path별 `.private-journal-sync.lock`으로 직렬화한다.
- lock을 얻지 못한 sync는 건너뛸 수 있으며 다음 SessionStart 또는 background sync가 pending 파일을 처리한다.
- Git pull이 반환한 추가·수정·삭제 Markdown 경로만 증분 인덱싱한다.
- query/search/list 요청에서 전체 Markdown이나 sidecar를 읽지 않는다.
- SQLite 인덱스가 없거나 `index_complete`가 false인 최초 복구 때는 전체 walk를 한 번 실행한다.
- 완전한 SQLite 인덱스에서는 migration 또는 명시적인 integrity rebuild 외에 전체 walk를 실행하지 않는다.

## 변경 시 검증

```bash
npm test -- --runInBand
npm run build
git diff --check
```

임베딩 차원이나 모델이 바뀌면 `INDEX_EMBEDDING_REVISION`을 올리고 전체 Markdown을 재임베딩하는 migration을 추가한다.
