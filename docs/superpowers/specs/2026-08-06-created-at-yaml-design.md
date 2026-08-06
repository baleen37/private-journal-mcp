# created_at YAML front matter 설계

## 목표

저널 Markdown의 front matter를 YAML formatter로 생성·파싱하고, 새 엔트리의 생성 시각을
`created_at` 하나로 표현한다. 기존 `date`와 `timestamp` front matter는 제거한다.
`write_journal` 호출자는 의미 있는 `title`을 필수로 전달한다.
기존 데이터는 data revision `1 -> 2` migration으로 변환하며, 변환 실패 시 원본을
보존한다.

SQLite 인덱스와 WAL/SHM 파일은 Markdown에서 재생성되는 파생물로 취급한다. Git remote가
있는 데이터 저장소에서 이미 추적 중인 이 파일들을 index에서 제거하되 로컬 파일은
보존하고, 이후 생성되는 파일은 `.git/info/exclude`로 계속 막는다. 데이터 revision
metadata인 `.private-journal-version.json`은 Git으로 동기화한다.

## 포맷

새 엔트리는 다음 front matter를 사용한다.

```yaml
---
title: 검색 결과 캐시 오류 수정
created_at: 2026-08-06T05:30:00.000Z
---
```

`created_at`은 UTC ISO 8601 문자열이다. `renderEntry()`와 `parseFrontmatter()`는 같은
직접 의존성 `yaml`을 사용한다. parser는 Git conflict 처리와 migration 직전의 읽기를
위해 legacy `date`/`timestamp`도 읽을 수 있지만, renderer는 전달받은 title과 새
`created_at`만 출력한다.

`write_journal`의 입력은 `title: string`, `content: string`, 선택적인 `section`이다.
title은 trim한 뒤 비어 있으면 거부한다. renderer는 전달받은 title을 front matter에
그대로 넣고 YAML formatter가 필요한 quoting을 처리한다. 기존 엔트리 migration은
본문에서 title을 추측하지 않고 기존 title을 보존한다.

내부 검색·정렬 계약은 기존 epoch millisecond timestamp를 당분간 유지한다. parser가
`created_at`을 epoch millisecond로 변환해 SearchService와 SQLite index에 전달한다.
이는 front matter 포맷 변경과 SQLite index schema revision 변경을 분리한다.

## Data revision 1 -> 2

`src/migration/data/001-frontmatter-created-at.ts`에 한 단계 migration을 둔다.

1. stage 안의 Markdown 파일을 재귀적으로 찾는다.
2. 각 파일의 YAML front matter를 읽는다.
3. 기존 `date`가 유효한 시각이면 이를 `created_at`으로 사용한다.
4. `date`가 없거나 유효하지 않으면 기존 numeric `timestamp`를 ISO 문자열로 변환한다.
5. `title`과 canonical `created_at`만 YAML formatter로 다시 쓰고 Markdown 본문은 그대로 둔다.
6. 복구 가능한 시각이 없으면 상대 경로를 포함한 오류로 migration을 실패시킨다.

변환된 Markdown은 모두 migration 결과의 invalidated path로 반환해 legacy embedding
sidecar를 제거한다. `MigrationManager.run()`은 실제 migration이 적용됐는지 반환한다.
서버와 `sync`는 이 값을 사용해 index가 완전한 상태였더라도 전체 Markdown을 한 번
backfill한다. 이 전체 walk는 migration이 발생한 경우에만 허용한다.

## Git 파생물 정리

`GitSync.ensureRepoMetadata()`가 다음 파일을 `.git/info/exclude`에 등록한다.

- `.private-journal-index.sqlite`
- `.private-journal-index.sqlite-wal`
- `.private-journal-index.sqlite-shm`
- 기존 lock 및 `.embedding` 파일

동일한 단계에서 `git ls-files`로 이미 추적 중인 파생물을 찾고 `git rm --cached`를
실행한다. 이 명령은 index에서만 제거하므로 작업 트리의 SQLite 파일은 삭제하지 않는다.
다음 `commitAndPush()`가 원격에서 제거를 반영한다.

## 범위 밖

- SQLite 테이블의 `date`/`timestamp` 컬럼 rename과 index schema revision 변경
- list/search 응답의 기존 내부 timestamp 필드 rename
- 과거 Git commit history에서 파생 파일을 삭제하는 history rewrite
- 원격 저장소에 이미 올라간 SQLite 파일을 이 작업 중 강제로 push하는 것

## 검증

- renderer가 YAML formatter로 `title`/`created_at`만 생성하는지 테스트한다.
- `write_journal`이 비어 있지 않은 title을 요구하고 Markdown에 전달한 title을 저장하는지 테스트한다.
- parser가 새 포맷과 legacy 포맷의 시각을 올바르게 계산하는지 테스트한다.
- migration이 `date` 우선, `timestamp` fallback, 본문 보존, 실패 시 원본 보존을 검증한다.
- migration 뒤 서버/sync가 index 전체 backfill을 수행하는지 검증한다.
- 이미 추적 중인 SQLite/WAL/SHM은 로컬 파일을 남긴 채 Git index에서 제거되고, version
  metadata는 유지되는지 GitSync 테스트로 검증한다.
- `npm test -- --runInBand`, `npm run build`, `git diff --check`를 실행한다.
