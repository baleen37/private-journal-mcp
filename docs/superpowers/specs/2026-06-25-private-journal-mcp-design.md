# Private Journal MCP — 설계 문서

작성일: 2026-06-25
상태: 승인됨 (구현 대기)

## 1. 목적

Claude(및 MCP 호환 클라이언트)에게 **로컬·프라이빗 저널링과 시맨틱 검색**을 제공하는 MCP 서버.
모든 처리는 로컬에서 일어나며 외부 API 호출이 없다. 선택적으로 GitHub 저장소에 자동
동기화하여 여러 머신 간 백업·공유가 가능하다.

`obra/private-journal-mcp`를 참고했으나, 그대로 베끼지 않고 다음을 직접 설계한다:
- 도구 이름을 표준 네이밍(`write/search/read/list_journal`)으로 정리
- project 저널 제거, **user 단일 저장소**
- **XDG Base Directory** 표준 준수
- 다국어(한국어) 임베딩 모델 사용
- **Git 자동 동기화**(commit/push는 서버 내부, sync(pull)는 CLI + hook)

## 2. 스택 / 위치

- 위치: `/Users/jito.hello/dev/wooto/private-journal-mcp/`
- 언어/런타임: TypeScript + Node.js
- 의존성:
  - `@modelcontextprotocol/sdk` — MCP 서버
  - `@xenova/transformers` — 로컬 임베딩
- 빌드: `tsc` → `dist/`, bin: `private-journal-mcp` → `dist/index.js`

## 3. 파일 구조

```
src/
  index.ts       # 엔트리포인트: 인자 파싱 → 서버 기동 | sync 서브커맨드
  server.ts      # MCP 서버 + 4개 도구 등록/핸들러
  journal.ts     # JournalManager: 항목 저장(.md), 디렉토리/파일명/frontmatter 생성
  paths.ts       # XDG 기반 데이터/캐시 경로 해석
  embeddings.ts  # EmbeddingService: 모델 로드, 벡터 생성/저장/유사도
  search.ts      # SearchService: 시맨틱 검색, 최근 목록, 백필
  git-sync.ts    # 공유 git 로직: init/clone, pull --rebase, 충돌해소, commit, push
  types.ts       # 공유 타입
test/            # jest 테스트
docs/superpowers/specs/  # 설계 문서
```

설계 원칙: 각 모듈은 단일 책임을 갖고 잘 정의된 인터페이스로 통신한다.
`git-sync.ts`는 서버(`write_journal` 후 commit+push)와 CLI(`sync`)가 **공유**한다.

## 4. MCP 도구 (4개)

| 이름 | 역할 | 파라미터 |
|---|---|---|
| `write_journal` | 6개 섹션 멀티 저널 작성 | 6개 섹션 (전부 optional, 최소 1개 필수) |
| `search_journal` | 시맨틱 검색 | `query`(필수), `limit`(기본 10), `sections`(optional) |
| `read_journal` | path로 단일 항목 전체 읽기 | `path`(필수) |
| `list_journal` | 최근 항목 목록(메타데이터만) | `limit`(기본 10), `days`(기본 30) |

원본 대비 변경:
- `process_thoughts` → `write_journal`
- `read_journal_entry` → `read_journal`
- `list_recent_entries` → `list_journal`
- `read_recent_entries`(원본 5번째 도구) → **제거**
- `type`(project/user/both) 파라미터 → **제거** (user 단일 저장소)

### write_journal 섹션 (6종, 순서 고정)
입력된 섹션만 이 순서로 기록한다:
1. `reflections` — 통합적 사고·감정 처리
2. `observations` — 1~2문장 단위 관찰
3. `project_notes` — 현재 코드베이스 관련 기술 메모
4. `user_context` — 협업자 패턴·선호
5. `technical_insights` — 일반 소프트웨어 엔지니어링 학습
6. `world_knowledge` — 일반 도메인 지식·사실

## 5. 데이터 저장

### 경로 (XDG 준수)
데이터 경로 해석 우선순위:
1. `PRIVATE_JOURNAL_PATH` (명시적 오버라이드, 최우선)
2. `$XDG_DATA_HOME/private-journal/`
3. `~/.local/share/private-journal/` (기본값)

모델 캐시 경로:
- `$XDG_CACHE_HOME/private-journal/models/`
- 기본 `~/.cache/private-journal/models/`
- (`@xenova/transformers`의 `env.cacheDir`로 지정)

### 디렉토리 / 파일 레이아웃
```
{dataPath}/
  YYYY-MM-DD/
    HH-MM-SS-{micro}.md         # 저널 항목
    HH-MM-SS-{micro}.embedding  # 임베딩 JSON (.md와 같은 이름, 확장자만 다름)
  .git/                         # git 동기화 활성화 시
```
- `{micro}`: 6자리 마이크로초 값 (밀리초×1000 + 랜덤 보정). 머신 간 파일명 충돌 방지.

### 마크다운 + YAML frontmatter
```
---
title: "HH:MM:SS - Month DD, YYYY"
date: 2026-06-25T12:34:56.789Z
timestamp: 1750800000000
---

## Reflections
...

## Observations
...
```
- `timestamp`(epoch ms)는 git 충돌 해소의 기준값으로도 쓰인다.

### .embedding JSON 포맷
```json
{
  "embedding": [/* number[] 384차원 */],
  "text": "임베딩에 사용된 추출 텍스트",
  "sections": ["reflections", "observations"],
  "timestamp": 1750800000000,
  "path": "/abs/path/to/entry.md"
}
```

## 6. 임베딩 & 검색

### 모델
- `Xenova/multilingual-e5-small`
  - 117M 파라미터, 384차원, 100+ 언어(한국어 포함), int8 ONNX 약 118MB
  - Transformers.js `feature-extraction` 파이프라인으로 동작 (ONNX 검증됨)
- **E5 prefix 규칙 필수**:
  - 문서(저장 시): `passage: <내용>`
  - 쿼리(검색 시): `query: <검색어>`
- pooling: mean, normalize: true

### EmbeddingService (싱글톤)
- 모델 lazy 로드(첫 사용 시), 30초 타임아웃 + 실패 시 안내(stale lock 정리)
- API: `generateEmbedding(text)`, `cosineSimilarity(a,b)`, `saveEmbedding`, `loadEmbedding`, `extractSearchableText(markdown)`

### 검색 (SearchService)
- 쿼리를 `query:` prefix로 임베딩 → 모든 `.embedding`과 코사인 유사도 → 상위 N개
- `sections` 필터 지원
- 결과: path, score, 발췌(excerpt) 반환

### 백필
- 서버 기동 시 `.md`는 있는데 `.embedding`이 없는 항목을 자동 생성
- 실패해도 서버는 계속 (best-effort, stderr 로그)

## 7. Git 동기화

### 활성화 조건
- `PRIVATE_JOURNAL_GIT_REMOTE` (예: `git@github.com:user/my-journal.git`)가 설정된 경우에만.
- 미설정 시: 로컬 파일만 사용, git 로직 전부 no-op.

### 인증
- `gh` CLI에 의존 (`gh auth login` 상태 전제). 별도 토큰/SSH 키 관리 로직 없음.

### 책임 분담
- **공유 모듈 `git-sync.ts`**: 모든 git 로직 집중
  - `ensureRepo()`: `.git` 없으면 원격에 내용 있으면 clone, 없으면 init + remote add
  - `pull()`: `git pull --rebase --autostash` + 충돌 해소
  - `commitAndPush()`: add → commit → pull → push (best-effort, 1회 재시도)
- **서버**: `write_journal` 핸들러가 파일 쓴 직후 `commitAndPush()` 호출 (best-effort)
- **CLI `sync`**: `ensureRepo()` → `pull()` → 밀린 push
- **SessionStart hook**: `private-journal-mcp sync` 실행 (README에 등록 예시 제공)

### commit+push 흐름 (서버, write 시)
```
1. git add -A && git commit -m "journal: <ISO timestamp>"
2. git pull --rebase --autostash    # 원격 최신 위에 내 커밋 재배치
3. 충돌 없으면 git push
4. push 거부되면(그새 원격 변경) → 2번부터 1회 재시도
5. 그래도 실패하면 best-effort 종료 (저장 자체는 성공 응답, 다음 write 때 밀린 커밋 함께 push)
```

### 충돌 해소 전략 (시점 기반, 완전 자동)
- **서로 다른 파일**: 파일명에 마이크로초 타임스탬프가 있어 머신 간 충돌이 거의 없음 → rebase가 양쪽 자동 보존.
- **같은 파일명 충돌**(드묾): 양쪽 frontmatter의 `timestamp`를 파싱·비교
  - **더 나중(최신) timestamp 버전 채택**, 오래된 쪽은 버림
  - **동점**(timestamp 동일): **로컬(내) 버전 우선**
  - 채택된 `.md` 기준으로 `.embedding`은 재생성
- 이 로직은 `git-sync.ts`에 두어 서버·CLI가 공유.

### .embedding 처리
- 저널 데이터 repo에서 `.embedding`은 git 추적 대상에 **포함** (백업).
- 주의: 두 종류의 repo를 구분한다.
  - **코드 repo** (`private-journal-mcp/` 자체): `.gitignore`에 `node_modules/`, `dist/` 포함.
  - **저널 데이터 repo** (`{dataPath}/`): `.md` + `.embedding` 전부 추적. 별도 `.gitignore` 없음.

## 8. 에러 처리

- 임베딩 실패 / git 실패는 **저널 저장을 막지 않는다** (best-effort, stderr 로그).
- 도구 핸들러는 예외를 MCP 에러 응답으로 변환.
- `write_journal`은 최소 1개 섹션이 비어있지 않은지 검증 (없으면 에러 응답).

## 9. 테스트 (jest)

- **paths**: XDG/env 우선순위, 기본값 해석
- **journal**: 파일명/디렉토리 생성, frontmatter 포맷, 섹션 순서
- **embeddings**: 코사인 유사도 계산, `extractSearchableText` 파싱, E5 prefix 적용 (모델 로딩은 모킹)
- **search**: 랭킹, sections 필터, limit
- **backfill**: `.md` 있고 `.embedding` 없을 때 생성
- **git-sync**: 충돌 해소(최신 timestamp 우선 / 동점 로컬 우선) — 로컬 임시 repo로 시나리오 구성

## 10. 비목표 (YAGNI)

- project 저널 / `type` 필터
- `read_recent_entries` 도구
- 토큰 직접 관리 (gh에 위임)
- 임베딩 모델 교체 UI/설정 (모델 고정; 필요 시 추후)
