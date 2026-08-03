# OpenCode native plugin final fix report

## 범위와 원인

- Branch 시작 HEAD는 `8d6a557`였다.
- `EmbeddingBroker`의 기본 worker launcher는 `process.execPath`를 그대로 실행했다.
  OpenCode host는 Bun standalone executable이므로, 자식도 bundled OpenCode entrypoint를
  실행한다. Bun CLI 모드로 전환하는 `BUN_BE_BUN=1`이 없으면 `dist/index.js
  embedding-worker` 인자가 실행되지 않아 embedding socket이 생기지 않는다.

## 변경

- `src/embedding-broker.ts`
  - Bun runtime (`process.versions.bun`)에서만 default worker child env에
    `BUN_BE_BUN=1`을 설정했다.
  - Node에서는 `env` spawn option 자체를 추가하지 않아 기존 launcher 상속 동작을
    그대로 유지한다.
- `test/embedding-broker.test.ts`
  - 실제 detached child launcher로 Bun standalone 환경 변수 전달을 확인하는 회귀
    테스트를 추가했다.
  - Node launcher가 `BUN_BE_BUN`을 추가하지 않는 회귀 테스트를 추가했다.
- `test/opencode-plugin.test.ts`
  - load된 package native plugin의 실제 `server`와 네 tool execute를 호출한다.
    write가 실제 markdown과 `.embedding`을 만들고, search가 이를 읽고, read/list가
    같은 journal entry를 처리하는 것을 확인한다.
  - 이 자동 테스트는 `EmbeddingBroker.prototype.embedText`만 결정론적 벡터로 대체한다.
    모델 다운로드와 네트워크 없이 실제 plugin adapter, `PrivateJournalServer`,
    `JournalManager`, `SearchService`, 파일 저장과 embedding sidecar 경계를 검증한다.
  - fake delegation test는 write/search/read/list 네 handler에 전달한 모든 args를
    정확히 검증하도록 보강했다.

## TDD 증거

### RED

```bash
npx jest --runInBand --runTestsByPath test/embedding-broker.test.ts \
  -t "starts the default worker as Bun"
```

변경 전 실패:

```text
Expected: "1"
Received: ""
```

임시 worker launcher가 받은 `BUN_BE_BUN`이 비어 있어, Bun standalone child가 CLI
모드로 전환되지 않는 원인을 직접 재현했다.

### GREEN

같은 명령이 변경 후 PASS했다. Bun test와 Node 환경 보존 test를 포함한
`test/embedding-broker.test.ts` 전체도 8/8 PASS했다.

## 자동 검증

```bash
npm run build
npx jest --runInBand --runTestsByPath \
  test/embedding-broker.test.ts \
  test/embedding-worker.test.ts \
  test/opencode-plugin.test.ts \
  test/server.test.ts \
  test/plugin-manifest.test.ts \
  test/bin-launcher.test.ts
```

결과: build exit 0, 6 suites, 46 tests PASS. `server.test.ts`의 기존
best-effort error-path `console.error` 출력만 있었고 실패는 없었다.

## 실제 Bun standalone plugin 실행

다음 조건으로 OpenCode bundled Bun host에서 package native plugin의 `server`를
직접 load하고 `write_journal`, `search_journal`, `read_journal`, `list_journal`을
실행했다.

```bash
BUN_BE_BUN=1 TMPDIR=<isolated> PRIVATE_JOURNAL_PATH=<isolated> \
PRIVATE_JOURNAL_GIT_REMOTE='' CLAUDE_PLUGIN_OPTION_GIT_REMOTE='' \
TRANSFORMERS_OFFLINE=1 XDG_CACHE_HOME=/Users/jito.hello/.cache \
opencode --eval '<plugin server load and four tool execute calls>'
```

결과:

```json
{"embeddingExists":true,"listCount":1,"readHasContent":true,"searchHasContent":true,"socketExists":true}
```

- `TMPDIR`와 journal path는 새 temporary directory였다.
- model cache는 기존 `/Users/jito.hello/.cache/private-journal/models`
  (Xenova multilingual-e5-small, 약 465 MiB)를 read-only input으로 사용했고,
  `TRANSFORMERS_OFFLINE=1`으로 네트워크를 차단했다.
- `--eval` process는 plugin이 연 IPC socket을 유지하므로 결과 출력 후 자동 종료되지
  않았다. 이 검증에서 만든 정확한 OpenCode worker와 parent PID만 종료했다.
  지속 host인 실제 OpenCode server에는 해당 종료 문제가 없다.

## isolated OpenCode registry smoke

```bash
HOME=<isolated> XDG_CONFIG_HOME=<isolated-config> \
XDG_CACHE_HOME=<isolated-cache> PRIVATE_JOURNAL_PATH=<isolated-journal> \
opencode serve --hostname 127.0.0.1 --port 41873
curl -fsS http://127.0.0.1:41873/experimental/tool/ids
```

`<isolated-config>/opencode/plugins/private-journal-mcp.js`는 checkout의
`opencode-plugin.mjs` symlink였다. registry 결과에 다음 네 tool이 모두 있었고,
server log에 plugin load error가 없었다.

```text
list_journal
read_journal
search_journal
write_journal
```

## 최종 확인

- `npm run build`: PASS
- `git diff --check`: PASS
- 변경 파일은 broker source/tracked dist, 두 test, 이 보고서로 한정했다.
