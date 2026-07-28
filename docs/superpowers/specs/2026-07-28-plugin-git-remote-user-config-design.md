# Plugin Git remote 설정 설계

날짜: 2026-07-28

## 목표

Claude Code에서 플러그인을 활성화할 때 Git remote를 입력할 수 있게 한다.
remote를 비워두면 저널은 local-only로 동작한다. 사용자가 더 이상
`PRIVATE_JOURNAL_GIT_REMOTE`를 셸이나 `launchctl`에 직접 설정할 필요가 없게 한다.

## 사용자 경험

`.claude-plugin/plugin.json`에 선택 입력값 `git_remote`를 추가한다.

```json
{
  "userConfig": {
    "git_remote": {
      "type": "string",
      "title": "Git remote",
      "description": "동기화할 Git remote URL입니다. 비워두면 local-only로 사용합니다."
    }
  }
}
```

Claude Code는 플러그인을 활성화할 때 이 필드를 보여준다. 사용자는 이후
`/plugin configure`에서도 값을 변경할 수 있다.

- 값이 있으면 Git sync를 활성화한다.
- 값이 없거나 공백뿐이면 local-only로 동작한다.
- Git 인증은 기존과 같이 사용자의 SSH 또는 Git credential 설정을 사용한다.

## 설정 해석

Git remote는 다음 우선순위로 결정한다.

1. 코드에서 전달한 `opts.remote`
2. Claude Code가 user config를 plugin subprocess에 전달하는
   `CLAUDE_PLUGIN_OPTION_GIT_REMOTE`
3. 기존 `PRIVATE_JOURNAL_GIT_REMOTE`
4. 모두 없으면 `undefined`

remote 문자열은 앞뒤 공백을 제거한다. 제거 후 빈 문자열이면 `undefined`로
취급한다. `GitSync`의 기존 `enabled` 판정이 `undefined`를 local-only로 처리하므로
동기화 로직 자체는 바꾸지 않는다.

`PRIVATE_JOURNAL_GIT_REMOTE`는 기존 사용자와 Codex 설정의 호환성을 위해 유지한다.
Codex plugin manifest에는 Claude 전용 `userConfig`를 추가하지 않는다.

## 변경 범위

### `.claude-plugin/plugin.json`

`userConfig.git_remote`를 추가한다. remote URL은 인증정보가 아니라 저장소 위치이므로
`sensitive`는 사용하지 않는다. 문서에는 URL 안에 토큰을 넣지 말라고 안내한다.

### `src/`

환경변수 우선순위와 공백 처리를 한 함수에서 담당한다. `runSync()`와
`PrivateJournalServer`가 같은 함수를 사용해 SessionStart sync와 MCP write가 동일한
설정을 보도록 한다.

### `README.md`

Claude Code의 설치 시 설정과 `/plugin configure` 재설정 방법을 문서화한다.
Codex와 수동 MCP 등록 사용자를 위해 기존 환경변수 방식도 호환 경로로 남긴다.

## 오류 처리

- 빈 값은 오류가 아니라 명시적인 local-only 선택이다.
- URL 형식은 사전 검증하지 않는다. Git은 SSH 별칭, 로컬 경로 등 다양한 remote
  형식을 지원하므로 `git ls-remote`의 기존 오류 처리를 그대로 사용한다.
- user config와 기존 env가 모두 있으면 user config가 우선한다.

## 테스트

- Claude plugin option 값이 기존 env보다 우선한다.
- Claude plugin option이 공백이면 기존 env로 fallback하지 않고 local-only가 된다.
  사용자가 설정창에서 비운 선택을 존중하기 위해서다.
- Claude plugin option이 없으면 기존 env를 사용한다.
- 두 값이 모두 없으면 local-only로 동작한다.
- `runSync()`와 `PrivateJournalServer`가 같은 remote 해석 함수를 사용한다.
- `claude plugin validate .`, 전체 테스트, TypeScript build가 통과한다.

## 성공 기준

- Claude Code에서 플러그인을 활성화하면 Git remote 입력 필드가 표시된다.
- remote를 입력한 세션의 시작 sync와 journal write가 같은 remote를 사용한다.
- remote를 비우면 Git 명령 없이 local-only로 정상 동작한다.
- 기존 `PRIVATE_JOURNAL_GIT_REMOTE` 사용자는 동작이 유지된다.
- Codex plugin 동작은 변경되지 않는다.

## 제외 범위

- Codex 전용 설정 UI
- 별도 config 파일 또는 interactive `configure` CLI
- Git credential 관리
- 기존 journal repo의 remote 자동 감지
