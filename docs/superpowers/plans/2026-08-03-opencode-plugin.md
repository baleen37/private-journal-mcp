# OpenCode Native Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `private-journal-mcp`를 OpenCode v1 native plugin으로 설치하고 네 개의 journal tool을 OpenCode tool registry에 노출한다.

**Architecture:** 기존 `PrivateJournalServer` handler를 공통 application 경계로 유지하고 초기화만 public `initialize()`로 분리한다. `opencode-plugin.mjs`는 이미 빌드된 server module을 import해 native OpenCode tool adapter를 만들며, 기존 MCP `stdio` registration은 그대로 유지한다. OpenCode plugin은 MCP child process를 추가로 띄우지 않는다.

**Tech Stack:** TypeScript 5.6, Node.js ES2022/CommonJS build, ESM `.mjs` OpenCode entrypoint, Zod 4, Jest 29/ts-jest, OpenCode v1 plugin API

## Global Constraints

- Target은 현재 안정적인 OpenCode v1 plugin API이며 OpenCode v2 beta plugin API는 포함하지 않는다.
- OpenCode entrypoint는 package `exports["./server"]`가 가리키는 `opencode-plugin.mjs`다.
- 도구 이름은 정확히 `write_journal`, `search_journal`, `read_journal`, `list_journal`을 유지한다.
- MCP와 OpenCode plugin은 동일한 `PrivateJournalServer` handler와 기존 data path/Git remote resolver를 사용한다.
- `@opencode-ai/plugin`은 runtime dependency로 추가하지 않는다. plugin entrypoint는 기존 `zod` dependency와 빌드된 `dist/`를 사용한다.
- OpenCode plugin은 OpenCode 프로젝트 경로를 journal data path로 해석하지 않는다.
- 기존 Claude Code/Codex manifest와 MCP wire result shape를 변경하지 않는다.
- `dist/`가 repository에 추적되고 있으므로 source 변경 후 `npm run build` 결과를 함께 검토한다.
- 작업 단위가 끝날 때마다 관련 테스트를 실행하고 의도한 파일만 commit한다.

---

### Task 1: MCP와 plugin이 공유하는 초기화 경계 정리

**Files:**
- Modify: `src/server.ts:65-98, 214-221`
- Test: `test/server.test.ts:351-390`

**Interfaces:**
- Consumes: 기존 `PrivateJournalServer.prepareData()`, `SearchService.backfill()`, MCP `run()` startup sequence
- Produces: `export function formatSearchResults(args: SearchArgs, results: SearchResult[]): string`; `PrivateJournalServer.initialize(): Promise<void>`

- [ ] **Step 1: 재사용 가능한 초기화의 실패 테스트 작성**

`test/server.test.ts`에 다음 테스트를 추가한다. 현재 `initialize()`가 없으므로 타입 회피를 위해 테스트에서 `(srv as any).initialize()`를 호출한다.

~~~ts
it('initializes pull, migration, and embedding backfill before returning', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srv-init-'));
  const srv = new PrivateJournalServer({ dataPath: dir, remote: 'resolved.git' });
  const order: string[] = [];

  jest.spyOn((srv as any).git, 'ensureRepo').mockImplementation(async () => {
    order.push('ensureRepo');
  });
  jest.spyOn((srv as any).git, 'pull').mockImplementation(async () => {
    order.push('pull');
    return [];
  });
  mockMigrationsRun.mockImplementationOnce(async () => {
    order.push('migration');
  });
  jest.spyOn(SearchService.prototype, 'backfill').mockImplementationOnce(async () => {
    order.push('backfill');
    return 0;
  });

  await (srv as any).initialize();

  expect(order).toEqual(['ensureRepo', 'pull', 'migration', 'backfill']);
});
~~~

- [ ] **Step 2: 테스트가 올바른 이유로 실패하는지 확인**

Run:

~~~bash
npx jest --runInBand --runTestsByPath test/server.test.ts -t "initializes pull, migration"
~~~

Expected: FAIL because `PrivateJournalServer` has no `initialize()` method.

- [ ] **Step 3: formatter와 초기화 메서드를 최소 구현**

`src/server.ts`에서 `formatSearchResults`의 `function` 선언을 `export function`으로 바꾼다.

`run()` 앞에 다음 메서드를 추가한다.

~~~ts
  async initialize(): Promise<void> {
    await this.prepareData();

    await this.search.backfill().catch((error: unknown) => {
      console.error('[private-journal] backfill failed (best-effort):', error);
    });
  }
~~~

기존 `run()`의 `prepareData()`와 `search.backfill()` 블록을 제거하고 다음 한 줄로 대체한다.

~~~ts
    await this.initialize();
~~~

`handleWrite()`의 `prepareData()` 호출은 그대로 둔다. write 중 동기화 시점의 기존 동작을 바꾸지 않는다.

- [ ] **Step 4: 초기화 테스트와 기존 startup 회귀 테스트 통과 확인**

Run:

~~~bash
npx jest --runInBand --runTestsByPath test/server.test.ts -t "initializes pull, migration|run performs ensureRepo|does not connect the MCP transport"
~~~

Expected: PASS. 기존 migration error가 transport 연결 전에 반환되고, 기존 `ensureRepo -> pull -> migration -> backfill -> connect` 순서가 유지된다.

- [ ] **Step 5: 전체 server 테스트 실행**

Run:

~~~bash
npx jest --runInBand --runTestsByPath test/server.test.ts
~~~

Expected: PASS with no new warnings or unhandled promise errors.

- [ ] **Step 6: 커밋**

~~~bash
git add src/server.ts test/server.test.ts
git commit -m "refactor: expose reusable journal initialization"
~~~

### Task 2: OpenCode native plugin adapter와 package entrypoint 추가

**Files:**
- Create: `opencode-plugin.mjs`
- Create: `test/opencode-plugin.test.ts`
- Modify: `package.json:8-14`

**Interfaces:**
- Consumes: `PrivateJournalServer.initialize()`, `handleWrite()`, `handleSearch()`, `handleRead()`, `handleList()`, `formatSearchResults()`, `JOURNAL_SECTIONS`, `MAX_SEARCH_LIMIT`
- Produces: `createTools(journal): Record<string, OpenCodeToolDefinition>`; named `PrivateJournalPlugin`; default `{ id: "private-journal-mcp", server: PrivateJournalPlugin }`

- [ ] **Step 1: plugin export와 tool delegation의 실패 테스트 작성**

`test/opencode-plugin.test.ts`에 Node child process로 ESM entrypoint를 검증하는 fixture를 만든다. child process는 실제 `dist/`를 import하며 빈 data directory를 사용하므로 embedding model을 다운로드하지 않는다.

~~~ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { pathToFileURL } from 'url';

const pluginPath = path.join(process.cwd(), 'opencode-plugin.mjs');

function runNodeModule(source: string, dataPath: string): string {
  return execFileSync(
    process.execPath,
    ['--input-type=module', '--eval', source],
    {
      cwd: process.cwd(),
      env: { ...process.env, PRIVATE_JOURNAL_PATH: dataPath },
      encoding: 'utf8',
    },
  );
}

describe('OpenCode plugin', () => {
  it('exports a v1 server plugin with the four journal tools', () => {
    const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-plugin-'));
    try {
      const moduleUrl = pathToFileURL(pluginPath).href;
      const output = runNodeModule(
        [
          'import pluginModule from ' + JSON.stringify(moduleUrl) + ';',
          'const hooks = await pluginModule.server({});',
          'console.log(JSON.stringify(Object.keys(hooks.tool).sort()));',
        ].join('\n'),
        dataPath,
      );

      expect(JSON.parse(output.trim())).toEqual([
        'list_journal',
        'read_journal',
        'search_journal',
        'write_journal',
      ]);
    } finally {
      fs.rmSync(dataPath, { recursive: true, force: true });
    }
  });
});
~~~

- [ ] **Step 2: 테스트가 entrypoint 부재로 실패하는지 확인**

Run:

~~~bash
npx jest --runInBand --runTestsByPath test/opencode-plugin.test.ts
~~~

Expected: FAIL because `opencode-plugin.mjs` does not exist.

- [ ] **Step 3: package export를 추가**

`package.json`의 `main` 뒤에 다음 `exports`를 추가한다. dependency가 바뀌지 않으므로 `package-lock.json`은 변경하지 않는다.

~~~json
  "main": "dist/index.js",
  "exports": {
    ".": "./dist/index.js",
    "./server": "./opencode-plugin.mjs"
  },
~~~

기존 `bin`은 `./bin/private-journal-mcp`를 그대로 유지한다.

- [ ] **Step 4: native plugin entrypoint를 구현**

`opencode-plugin.mjs`는 ESM으로 작성한다. CommonJS로 빌드된 `dist/server.js`는 default import로 받아 named export를 꺼내 CommonJS/ESM interop 차이를 피한다.

~~~js
import serverModule from './dist/server.js';
import searchModule from './dist/search.js';
import typesModule from './dist/types.js';
import { z } from 'zod';

const { PrivateJournalServer, formatSearchResults } = serverModule;
const { MAX_SEARCH_LIMIT } = searchModule;
const { JOURNAL_SECTIONS } = typesModule;
const boundedLimit = z.number().int().positive().max(MAX_SEARCH_LIMIT).optional();
const section = z.enum(JOURNAL_SECTIONS).optional();

const toJson = (value) => JSON.stringify(value, null, 2);

export function createTools(journal) {
  return {
    write_journal: {
      description: 'Write a durable private journal entry. section defaults to observations.',
      args: {
        content: z.string(),
        section,
      },
      async execute(args) {
        return toJson(await journal.handleWrite(args));
      },
    },
    search_journal: {
      description: 'Search private journal entries semantically and return readable markdown snippets.',
      args: {
        query: z.string(),
        limit: boundedLimit,
        section,
        minScore: z.number().min(0).max(1).optional(),
      },
      async execute(args) {
        const results = await journal.handleSearch(args);
        return formatSearchResults(args, results);
      },
    },
    read_journal: {
      description: 'Read the full content of one journal entry by path.',
      args: { path: z.string() },
      async execute(args) {
        return toJson(await journal.handleRead(args));
      },
    },
    list_journal: {
      description: 'List recent journal entries with paths, dates, and sections.',
      args: {
        limit: boundedLimit,
        days: z.number().int().positive().max(3650).optional(),
      },
      async execute(args) {
        return toJson(await journal.handleList(args));
      },
    },
  };
}

export async function PrivateJournalPlugin() {
  const journal = new PrivateJournalServer();
  await journal.initialize();
  return { tool: createTools(journal) };
}

export default {
  id: 'private-journal-mcp',
  server: PrivateJournalPlugin,
};
~~~

위 코드의 description은 기존 `src/server.ts`의 section 목록과 search score guidance를 포함하도록 확장한다. MCP와 OpenCode에서 도구 사용법이 다르게 설명되지 않게 한다.

- [ ] **Step 5: adapter behavior 테스트 추가**

`createTools`에 fake journal object를 주입하는 child-process fixture를 추가한다. 다음 네 가지를 각각 검증한다.

~~~js
const tools = createTools({
  handleWrite: async (args) => ({ path: '/tmp/' + args.section + '.md' }),
  handleSearch: async () => [{
    path: '/tmp/entry.md',
    score: 0.8634,
    excerpt: 'plugin result',
    sections: ['technical_insights'],
    timestamp: Date.parse('2026-08-03T00:00:00Z'),
  }],
  handleRead: async () => ({ content: 'full entry' }),
  handleList: async () => [{
    path: '/tmp/entry.md',
    title: 'Entry',
    date: '2026-08-03',
    timestamp: Date.parse('2026-08-03T00:00:00Z'),
    sections: ['technical_insights'],
  }],
});

expect(JSON.parse(await tools.write_journal.execute({
  content: 'note',
  section: 'technical_insights',
}))).toEqual({
  path: '/tmp/technical_insights.md',
});
expect(await tools.search_journal.execute({ query: 'plugin' })).toContain(
  '### Journal Search Results',
);
expect(JSON.parse(await tools.read_journal.execute({ path: '/tmp/entry.md' }))).toEqual({
  content: 'full entry',
});
expect(JSON.parse(await tools.list_journal.execute({}))).toHaveLength(1);
~~~

The fake object tests adapter delegation and output shape without loading the embedding model or writing journal files.

- [ ] **Step 6: Build and run plugin tests**

Run:

~~~bash
npm run build
npx jest --runInBand --runTestsByPath test/opencode-plugin.test.ts test/server.test.ts
~~~

Expected: PASS. `dist/server.js` contains the exported `formatSearchResults` and `initialize` symbols needed by the `.mjs` entrypoint.

- [ ] **Step 7: Commit the plugin adapter**

~~~bash
git add opencode-plugin.mjs package.json dist src/server.ts test/opencode-plugin.test.ts
git commit -m "feat: add OpenCode native journal plugin"
~~~

### Task 3: 설치 문서와 manifest 계약 회귀 보호

**Files:**
- Modify: `README.md:62-105`
- Modify: `test/plugin-manifest.test.ts:4-17`

**Interfaces:**
- Consumes: package `exports["./server"]`, existing `PRIVATE_JOURNAL_GIT_REMOTE` and `CLAUDE_PLUGIN_OPTION_GIT_REMOTE` behavior
- Produces: user-facing OpenCode install instructions without changing Claude/Codex manifest behavior

- [ ] **Step 1: package contract test 작성**

`test/plugin-manifest.test.ts`에 다음 테스트를 추가한다.

~~~ts
it('declares the OpenCode server entrypoint without changing existing plugin manifests', () => {
  const packagePath = path.join(__dirname, '..', 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

  expect(packageJson.main).toBe('dist/index.js');
  expect(packageJson.bin['private-journal-mcp']).toBe('./bin/private-journal-mcp');
  expect(packageJson.exports['./server']).toBe('./opencode-plugin.mjs');
});
~~~

- [ ] **Step 2: package contract test 실행**

Run:

~~~bash
npx jest --runInBand --runTestsByPath test/plugin-manifest.test.ts -t "OpenCode server entrypoint"
~~~

Expected: PASS after Task 2. If run before Task 2, it must fail because the export is absent.

- [ ] **Step 3: OpenCode 설치 문서 추가**

기존 Codex section 뒤에 다음 내용을 추가한다.

OpenCode:

~~~json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["private-journal-mcp"]
}
~~~

For a local checkout, build first and link the entrypoint into the project
plugin directory so OpenCode loads it automatically:

~~~bash
npm install && npm run build
mkdir -p .opencode/plugins
ln -sfn /absolute/path/to/private-journal-mcp/opencode-plugin.mjs \
  .opencode/plugins/private-journal-mcp.mjs
~~~

The plugin exposes `write_journal`, `search_journal`, `read_journal`, and
`list_journal` as native OpenCode tools. It uses the same local data path and
Git remote environment variables as the MCP server. Set
`PRIVATE_JOURNAL_GIT_REMOTE` for Git sync; leave it unset for local-only storage.

기존 manual MCP registration section은 OpenCode plugin을 사용하지 않는 사용자를 위해 유지한다.

- [ ] **Step 4: manifest와 launcher 회귀 테스트 실행**

Run:

~~~bash
npx jest --runInBand --runTestsByPath test/plugin-manifest.test.ts test/bin-launcher.test.ts
~~~

Expected: PASS. Claude와 Codex manifest assertion은 그대로 유지되고 launcher는 `dist/`를 자기 위치 기준으로 해석한다.

- [ ] **Step 5: 커밋**

~~~bash
git add README.md test/plugin-manifest.test.ts
git commit -m "docs: document OpenCode plugin installation"
~~~

### Task 4: 빌드 결과와 격리된 OpenCode runtime 검증

**Files:**
- Verify: `dist/index.js`, `dist/server.js`, `dist/search.js`, `dist/types.js`
- Verify: `opencode-plugin.mjs`, `package.json`, `README.md`
- Test: `test/opencode-plugin.test.ts`, `test/server.test.ts`, `test/plugin-manifest.test.ts`, `test/bin-launcher.test.ts`

**Interfaces:**
- Consumes: published-package shape, OpenCode v1.18.3 loader contract, native tool registry endpoint
- Produces: evidence that the package loads in an isolated OpenCode config and exposes all four tools

- [ ] **Step 1: Build and inspect the tracked distribution**

Run:

~~~bash
npm run build
git diff --check
git status --short
~~~

Expected: build succeeds, generated `dist/` changes contain `initialize` and exported `formatSearchResults`, and no unrelated files are modified.

- [ ] **Step 2: Repository tests 실행**

Run:

~~~bash
npx jest --runInBand --runTestsByPath \
  test/server.test.ts \
  test/opencode-plugin.test.ts \
  test/plugin-manifest.test.ts \
  test/bin-launcher.test.ts
~~~

Expected: PASS. Full repository validation, if needed, uses the existing worktree exclusion:

~~~bash
npx jest --runInBand --testPathIgnorePatterns='/.worktrees/'
~~~

- [ ] **Step 3: local plugin을 격리된 OpenCode plugin directory에 연결**

Repository root에서 실행한다. 임시 디렉터리는 실제 사용자 OpenCode 설정을 변경하지 않는다.

~~~bash
tmp_root="$(mktemp -d)"
config_root="$tmp_root/config"
cache_root="$tmp_root/cache"
journal_root="$tmp_root/journal"
mkdir -p "$config_root/opencode/plugins" "$cache_root" "$journal_root"

ln -s "$PWD/opencode-plugin.mjs" \
  "$config_root/opencode/plugins/private-journal-mcp.mjs"
~~~

Expected: isolated global OpenCode plugin directory에 repository entrypoint가 연결된다. OpenCode가 이 directory의 plugin을 startup 시 자동 로드한다.

- [ ] **Step 4: isolated OpenCode에서 native tool registry 확인**

사용하지 않는 local port를 지정하고 server PID를 정리한다.

~~~bash
port=41873
HOME="$tmp_root/home" \
XDG_CONFIG_HOME="$config_root" \
XDG_CACHE_HOME="$cache_root" \
PRIVATE_JOURNAL_PATH="$journal_root" \
opencode serve --hostname 127.0.0.1 --port "$port" >"$tmp_root/opencode.log" 2>&1 &
opencode_pid=$!
trap 'kill "$opencode_pid" 2>/dev/null || true; rm -rf "$tmp_root"' EXIT

for attempt in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$port/experimental/tool/ids" >"$tmp_root/tool-ids.json"; then
    break
  fi
  sleep 1
done

rg 'write_journal|search_journal|read_journal|list_journal' "$tmp_root/tool-ids.json"
~~~

Expected: endpoint가 네 tool ID를 모두 반환하고 `$tmp_root/opencode.log`에 plugin load 또는 entrypoint error가 없다. 고정 port가 사용 중이면 다른 unused port로 재실행한 뒤 결과를 판단한다.

- [ ] **Step 5: 최종 working tree 상태 확인**

Run:

~~~bash
git status --short --branch
git diff --check
~~~

Expected: 의도한 source, test, documentation, package, generated `dist/`만 남고 isolated OpenCode smoke가 repository 파일을 만들지 않는다.

