# private-journal-mcp

로컬 파일에 저널을 저장하고, 다국어 임베딩으로 시맨틱 검색하는 MCP 서버다.
검색/임베딩 추론은 로컬에서 수행되며, 임베딩 모델은 최초 1회만 다운로드해 캐시한다.
선택적으로 Git 원격에 자동 동기화할 수 있다.

## 도구

- `write_journal`
  - 6개 섹션(`reflections`, `observations`, `project_notes`, `user_context`, `technical_insights`, `world_knowledge`) 중 하나 이상을 받아 항목을 저장한다.
- `search_journal`
  - `query`로 시맨틱 검색한다.
  - 선택 인자: `limit`, `sections`
- `read_journal`
  - `path`로 개별 마크다운 항목 전체를 읽는다.
- `list_journal`
  - 최근 항목을 나열한다.
  - 선택 인자: `limit`, `days`

## 저장 위치

### 저널 데이터

우선순위:

1. `PRIVATE_JOURNAL_PATH`
2. `$XDG_DATA_HOME/private-journal`
3. `~/.local/share/private-journal`

### 모델 캐시

우선순위:

1. `$XDG_CACHE_HOME/private-journal/models`
2. `~/.cache/private-journal/models`

기본 임베딩 모델은 `Xenova/multilingual-e5-small`이다.

## 설치 / 빌드

```bash
npm install
npm run build
```

로컬 실행:

```bash
node dist/index.js
```

`sync` 서브커맨드는 Git 원격이 설정되지 않으면 no-op 으로 종료한다.

```bash
node dist/index.js sync
```

## Claude MCP 등록

```bash
claude mcp add private-journal -- node /absolute/path/to/private-journal-mcp/dist/index.js
```

## Git 동기화 (선택)

Git 동기화는 `PRIVATE_JOURNAL_GIT_REMOTE`가 있을 때만 활성화된다.

```bash
export PRIVATE_JOURNAL_GIT_REMOTE="git@github.com:youruser/my-journal.git"
```

권장 전제:

- `gh auth login` 또는 해당 원격에 맞는 Git 인증이 이미 되어 있어야 한다.

동작:

- `write_journal` 저장 직후 `commit + pull --rebase + push`를 best-effort 로 시도한다.
- `node dist/index.js sync`는 세션 시작 전에 `pull`과 밀린 커밋 푸시를 담당한다.

## SessionStart hook 예시

`~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/private-journal-mcp/dist/index.js sync"
          }
        ]
      }
    ]
  }
}
```

## 충돌 처리

- 서로 다른 항목은 파일명에 마이크로초 suffix 가 포함되어 대부분 자동 공존한다.
- 같은 파일명이 충돌하면 frontmatter `timestamp`가 더 큰 쪽을 채택한다.
- `timestamp`가 같으면 로컬 버전을 우선한다.
- `.embedding` 파일은 채택된 마크다운 기준으로 다시 생성될 수 있다.
