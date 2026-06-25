# 최신 스택 마이그레이션 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `private-journal-mcp`의 의존성과 MCP 서버 API 패턴을 최신 안정 스택으로 전환하되 기존 동작을 100% 보존한다.

**Architecture:** 의존성을 먼저 교체(`@xenova/transformers`→`@huggingface/transformers`, MCP SDK 1.29, zod 4)한 뒤, 임베딩 import 경로를 바꾸고, 마지막으로 서버의 도구 등록 레이어를 저수준 `Server`/`setRequestHandler`에서 고수준 `McpServer`/`registerTool`(zod)로 교체한다. 비즈니스 로직 핸들러는 그대로 둔다.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk@^1.29.0`, `@huggingface/transformers@^4.2.0`, `zod@^4.4.3`, Jest + ts-jest.

## Global Constraints

- `@modelcontextprotocol/sdk`: `^1.29.0`
- `@huggingface/transformers`: `^4.2.0` (`@xenova/transformers` 완전 제거)
- `zod`: `^4.4.3`
- 임베딩 모델 문자열 `Xenova/multilingual-e5-small` 유지 → 기존 `.embedding` 파일 재생성 불필요
- 4개 도구 이름/description/입출력 계약 보존: `write_journal`, `search_journal`, `read_journal`, `list_journal`
- 핸들러 메서드 시그니처 보존: `handleWrite(JournalSections)`, `handleSearch(SearchArgs)`, `handleRead(ReadArgs)`, `handleList(ListArgs)`

---

### Task 1: 의존성 교체 및 설치

**Files:**
- Modify: `package.json` (dependencies)

**Interfaces:**
- Consumes: 없음
- Produces: `@huggingface/transformers`, `@modelcontextprotocol/sdk@^1.29.0`, `zod` 가 node_modules에 설치된 상태

- [ ] **Step 1: package.json dependencies 블록 교체**

`package.json`의 `dependencies`를 아래로 변경한다:

```json
  "dependencies": {
    "@huggingface/transformers": "^4.2.0",
    "@modelcontextprotocol/sdk": "^1.29.0",
    "zod": "^4.4.3"
  },
```

(`@xenova/transformers` 줄 제거, `zod` 추가, sdk 버전 상향)

- [ ] **Step 2: 설치**

Run: `npm install`
Expected: 에러 없이 완료, `package-lock.json` 갱신. `node_modules/@xenova` 부재, `node_modules/@huggingface/transformers` 존재.

- [ ] **Step 3: 커밋**

```bash
git add package.json package-lock.json
git commit -m "chore: 최신 스택 의존성으로 교체 (transformers v4, mcp sdk 1.29, zod 4)"
```

---

### Task 2: 임베딩 import 경로를 @huggingface/transformers로 전환

**Files:**
- Modify: `src/embeddings.ts:56`
- Modify: `test/e2e.manual.test.ts:30`
- Test: `test/embeddings.test.ts` (기존, 수정 없이 통과 확인)

**Interfaces:**
- Consumes: Task 1의 `@huggingface/transformers`
- Produces: 변경 없음 — `EmbeddingService.generateEmbedding(text, kind)` 시그니처/반환(`number[]`) 동일

- [ ] **Step 1: 기존 임베딩 테스트가 통과하는지 먼저 확인 (회귀 베이스라인)**

Run: `npx jest test/embeddings.test.ts -v`
Expected: PASS (변경 전 그린 상태 확인)

- [ ] **Step 2: src/embeddings.ts 동적 import 교체**

`src/embeddings.ts` 56번째 줄을 변경:

```ts
// 변경 전
const { pipeline, env } = await import('@xenova/transformers');
// 변경 후
const { pipeline, env } = await import('@huggingface/transformers');
```

다른 줄은 변경하지 않는다 (`env.cacheDir`, `pipeline('feature-extraction', MODEL)`, `{ pooling: 'mean', normalize: true }`, `MODEL = 'Xenova/multilingual-e5-small'` 모두 유지).

- [ ] **Step 3: e2e 수동 테스트의 import 교체**

`test/e2e.manual.test.ts` 30번째 줄을 변경:

```ts
// 변경 전
const { env, pipeline } = await import('@xenova/transformers');
// 변경 후
const { env, pipeline } = await import('@huggingface/transformers');
```

- [ ] **Step 4: 임베딩 테스트 재실행으로 회귀 없음 확인**

Run: `npx jest test/embeddings.test.ts -v`
Expected: PASS

- [ ] **Step 5: 전체 소스에 xenova 잔존 참조가 없는지 확인**

Run: `grep -rn "xenova" src test`
Expected: 출력 없음 (exit code 1)

- [ ] **Step 6: 커밋**

```bash
git add src/embeddings.ts test/e2e.manual.test.ts
git commit -m "refactor: @huggingface/transformers로 임베딩 import 전환"
```

---

### Task 3: 서버 도구 등록을 McpServer/registerTool(zod)로 전환

**Files:**
- Modify: `src/server.ts` (imports + `run()` 메서드 본문)
- Test: `test/server.test.ts` (기존, 핸들러 직접 호출 — 수정 없이 통과 확인)

**Interfaces:**
- Consumes: Task 1의 `@modelcontextprotocol/sdk@^1.29.0`, `zod`
- Produces: 변경 없음 — `PrivateJournalServer`의 `handleWrite/handleSearch/handleRead/handleList`, `run()` public 시그니처 동일

- [ ] **Step 1: 기존 server 테스트가 통과하는지 먼저 확인 (회귀 베이스라인)**

Run: `npx jest test/server.test.ts -v`
Expected: PASS (핸들러를 직접 호출하므로 변경 전 그린)

- [ ] **Step 2: import 교체**

`src/server.ts` 상단 import 3줄을 교체:

```ts
// 변경 전 (3~5번째 줄)
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// 변경 후
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
```

- [ ] **Step 3: run() 내부 서버 구성 교체**

`src/server.ts`의 `run()` 메서드에서, `const server = new Server(...)`부터 `await server.connect(transport);` 까지(현재 100~187번째 줄)를 아래로 교체한다. 그 위의 `ensureRepo`/`backfill` best-effort 블록(91~98번째 줄)과 메서드 시그니처는 그대로 둔다.

```ts
    const server = new McpServer({ name: 'private-journal-mcp', version: '0.1.0' });

    const toText = (result: unknown) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    });

    server.registerTool(
      'write_journal',
      {
        description: 'Write a journal entry using one or more optional sections.',
        inputSchema: Object.fromEntries(
          SECTION_KEYS.map((key) => [key, z.string().optional()]),
        ),
      },
      async (args) => toText(await this.handleWrite(args as JournalSections)),
    );

    server.registerTool(
      'search_journal',
      {
        description: 'Search journal entries semantically.',
        inputSchema: {
          query: z.string(),
          limit: z.number().optional(),
          sections: z.array(z.string()).optional(),
        },
      },
      async (args) => toText(await this.handleSearch(args as SearchArgs)),
    );

    server.registerTool(
      'read_journal',
      {
        description: 'Read a journal entry by file path.',
        inputSchema: { path: z.string() },
      },
      async (args) => toText(await this.handleRead(args as ReadArgs)),
    );

    server.registerTool(
      'list_journal',
      {
        description: 'List recent journal entries.',
        inputSchema: {
          limit: z.number().optional(),
          days: z.number().optional(),
        },
      },
      async (args) => toText(await this.handleList(args as ListArgs)),
    );

    const transport = new StdioServerTransport();
    await server.connect(transport);
```

> 참고: `registerTool`의 `inputSchema`는 zod 스키마들의 **객체(raw shape)** 를 받는다(`z.object(...)`로 감싸지 않음). 핸들러 인자는 검증된 객체이며, 기존 핸들러 타입(`JournalSections`/`SearchArgs`/`ReadArgs`/`ListArgs`)으로 캐스팅해 그대로 위임한다.

- [ ] **Step 4: 빌드로 타입 통과 확인**

Run: `npm run build`
Expected: 타입 에러 0, `dist/server.js` 생성.

- [ ] **Step 5: server 테스트 재실행으로 회귀 없음 확인**

Run: `npx jest test/server.test.ts -v`
Expected: PASS

- [ ] **Step 6: 커밋**

```bash
git add src/server.ts
git commit -m "refactor: McpServer/registerTool(zod) 패턴으로 서버 전환"
```

---

### Task 4: 전체 빌드·테스트·기동 검증

**Files:**
- 없음 (검증 전용)

**Interfaces:**
- Consumes: Task 1~3 결과
- Produces: 없음

- [ ] **Step 1: 클린 빌드**

Run: `npm run build`
Expected: 타입 에러 0.

- [ ] **Step 2: 전체 테스트 실행**

Run: `npm test`
Expected: 모든 스위트 PASS (e2e.manual은 opt-in이면 skip 표시 — 기존 동작과 동일하면 정상).

- [ ] **Step 3: MCP 서버 stdio 기동 + tools/list 확인**

Run:
```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node dist/index.js 2>/dev/null
```
Expected: `tools/list` 응답에 `write_journal`, `search_journal`, `read_journal`, `list_journal` 4개 도구가 노출된다.

- [ ] **Step 4: 잔존 xenova 참조 최종 확인**

Run: `grep -rn "xenova\|@xenova" src test package.json`
Expected: 출력 없음.

(이 Task는 검증만 하므로 별도 커밋 없음. 앞선 커밋들로 충분.)
