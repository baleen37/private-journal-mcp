# private-journal-mcp OpenCode Plugin 설계

## 목표

`private-journal-mcp`를 OpenCode가 직접 로드하는 native plugin으로 제공한다.
OpenCode에서 plugin을 설치하면 `write_journal`, `search_journal`, `read_journal`,
`list_journal` 네 도구를 native tool로 사용할 수 있어야 한다.

기존 Claude Code/Codex MCP 서버와 도구 이름, 인자 계약, 저장소·Git 동기화 동작은
유지한다.

## 배경과 제약

현재 저장소의 `bin/private-journal-mcp`는 MCP `stdio` 서버 launcher다. OpenCode의
plugin은 JavaScript/TypeScript module이고 native tool을 반환하는 별도 계약이다.
OpenCode의 MCP 설정과 plugin 설정은 서로 다른 확장 경로이므로, plugin이 기존 MCP
프로세스를 다시 등록하는 우회 계층은 이번 설계에서 사용하지 않는다.

대상은 현재 안정적인 OpenCode v1 plugin API다. OpenCode v2 beta plugin API는 이번
범위에 포함하지 않는다.

## 설계 결정

### 1. 공통 로직 재사용

OpenCode plugin은 새 저널 구현을 만들지 않는다. 기존 `PrivateJournalServer`의
공개 handler를 호출한다.

- `handleWrite(args)`는 파일 저장, migration 준비, Git 동기화, embedding 처리를
  그대로 수행한다.
- `handleSearch(args)`는 기존 검색 결과를 반환하고, plugin adapter가 기존
  `formatSearchResults()`를 사용해 MCP와 동일한 markdown 결과를 반환한다.
- `handleRead(args)`는 기존 realpath 및 markdown 파일 경계 검사를 그대로 사용한다.
- `handleList(args)`는 기존 최근 엔트리 검색을 그대로 사용한다.

현재 handler가 MCP registration과 같은 클래스에 있지만 이미 public application
경계로 분리되어 있으므로, 이번 변경에서 별도 도메인 서비스 추출은 하지 않는다.
동일 로직을 두 번째로 복사하지 않는 것이 우선이다.

### 2. 초기화 경계

`PrivateJournalServer`에 public `initialize()`를 추가한다. 이 메서드는 현재
`run()`이 transport 연결 전에 수행하는 작업을 담당한다.

1. Git remote가 있으면 repository를 준비하고 pull한다.
2. data migration을 실행한다.
3. 필요한 embedding backfill을 best-effort로 실행한다.

기존 `run()`은 `initialize()`를 호출한 뒤 MCP transport를 연결한다. OpenCode
plugin은 서버를 한 번 생성하고 plugin 함수 초기화 중 `initialize()`를 await한 뒤
도구를 반환한다. 초기화 실패 시 plugin 로딩이 실패하고 도구를 노출하지 않는다.

### 3. OpenCode entrypoint

패키지 root의 `opencode-plugin.mjs`를 OpenCode server entrypoint로 둔다.

`package.json`은 기존 Node launcher 계약을 유지하면서 OpenCode의 `./server`
subpath를 추가한다.

```json
{
  "main": "dist/index.js",
  "exports": {
    ".": "./dist/index.js",
    "./server": "./opencode-plugin.mjs"
  }
}
```

plugin module은 현재 안정 v1 loader와 legacy loader를 모두 안전하게 인식할 수
있도록 named function과 default server module을 함께 제공한다.

```js
const serverPlugin = async () => {
  const journal = new PrivateJournalServer();
  await journal.initialize();
  return { tool: createTools(journal) };
};

export const PrivateJournalPlugin = serverPlugin;
export default { id: "private-journal-mcp", server: serverPlugin };
```

OpenCode plugin runtime 자체의 helper를 필수 runtime dependency로 추가하지 않는다.
기존 `zod` dependency로 native tool argument schema를 만들고, entrypoint는 이미
빌드된 `dist/`의 server module을 import한다. 따라서 기존 MCP/CLI 설치가
OpenCode 전용 SDK를 추가로 설치할 필요가 없다.

### 4. Tool adapter 계약

plugin은 다음 도구를 반환한다.

| 도구 | 인자 | 결과 |
| --- | --- | --- |
| `write_journal` | `content: string`, optional `section` | 기존 `{ path }` JSON 문자열 |
| `search_journal` | `query: string`, optional `limit`, `section`, `minScore` | 기존 markdown 검색 결과 |
| `read_journal` | `path: string` | 기존 `{ content }` JSON 문자열 |
| `list_journal` | optional `limit`, `days` | 기존 최근 엔트리 배열 JSON 문자열 |

Argument schema는 MCP registration과 같은 양의 limit, section enum, minScore 범위를
검증한다. OpenCode tool의 `execute`는 검증된 인자를 기존 handler에 전달한다.

OpenCode tool 결과는 문자열로 반환한다. JSON 결과는 기존 MCP wire shape를
유지하고, 검색은 LLM이 바로 읽을 수 있는 현재 markdown formatter를 재사용한다.

### 5. 환경과 저장 경로

plugin은 OpenCode 프로젝트 경로를 journal data path로 사용하지 않는다.
`PrivateJournalServer()`의 기존 환경 우선순위와 `resolveDataPath()`를 그대로
사용한다.

- `PRIVATE_JOURNAL_PATH`가 있으면 이를 사용한다.
- 없으면 XDG data path 또는 기본 local data path를 사용한다.
- Git remote는 기존 `CLAUDE_PLUGIN_OPTION_GIT_REMOTE` 및
  `PRIVATE_JOURNAL_GIT_REMOTE` resolver를 그대로 사용한다.

OpenCode plugin 설치 자체는 journal data를 프로젝트별로 분리하지 않는다. 기존
Claude Code/Codex 세션과 같은 개인 journal 저장소를 공유하는 것이 목표다.

## 파일 변경 범위

- `src/server.ts`
  - 초기화 로직을 `initialize()`로 추출
  - 검색 formatter를 plugin adapter에서 재사용할 수 있도록 export
- `opencode-plugin.mjs`
  - OpenCode native plugin entrypoint와 네 도구 adapter
- `package.json`
  - `exports["./server"]` 추가
- `test/opencode-plugin.test.ts`
  - plugin export, 도구 이름, argument schema, handler delegation, 결과 formatting
  검증
- `test/plugin-manifest.test.ts`
  - OpenCode entrypoint와 기존 Claude/Codex manifest가 함께 유지되는지 검증
- `README.md`
  - OpenCode plugin 설치, local path 테스트, global install, 환경 변수 사용법 추가

## 검증 기준

1. `npm run build`가 성공한다.
2. 기존 Jest 테스트 전체가 통과한다.
3. plugin module을 직접 import했을 때 안정 v1 default server와 legacy named export가
   모두 존재한다.
4. plugin이 반환하는 도구가 정확히 네 개이고 이름과 argument schema가 MCP 계약과
   일치한다.
5. 임시 journal data path에서 plugin 초기화 후 write, search, read, list가 실제
   파일과 embedding을 통해 동작한다.
6. OpenCode 1.x isolated config에서 local package를 plugin으로 로드했을 때
   plugin load error가 없고 네 도구가 tool registry에 나타난다.
7. 기존 `node dist/index.js`, Claude manifest, Codex manifest의 동작은 변하지
   않는다.

## 제외 범위

- OpenCode v2 beta plugin API
- OpenCode `opencode.json`에 MCP 서버를 자동으로 영구 기록하는 기능
- 별도 remote MCP HTTP 서버
- journal tool 이름이나 인자 계약 변경
- 기존 Claude Code/Codex plugin manifest 재설계

## 외부 계약 참고

- OpenCode plugin 문서: https://opencode.ai/docs/plugins/
- OpenCode custom tools 문서: https://opencode.ai/docs/custom-tools/
- OpenCode v1.18.3 plugin loader: https://github.com/anomalyco/opencode/blob/v1.18.3/packages/opencode/src/plugin/index.ts
- OpenCode v1.18.3 plugin entrypoint resolver: https://github.com/anomalyco/opencode/blob/v1.18.3/packages/opencode/src/plugin/shared.ts
