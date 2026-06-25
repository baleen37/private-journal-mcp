# 최신 스택 마이그레이션 설계

날짜: 2026-06-26

## 목표

`private-journal-mcp`의 의존성과 API 사용 패턴을 최신 안정 스택으로 전환한다.
기존 동작(4개 MCP 도구, 시맨틱 검색, Git 동기화)은 100% 보존한다.

## 배경 (context7 + npm registry 확인 결과)

- `@xenova/transformers` (v2)는 **deprecated**. 공식 후속은 `@huggingface/transformers`.
  - npm 최신: **4.2.0**. `pipeline`/`feature-extraction`/`env.cacheDir` API 및 `Xenova/` 모델 경로 호환.
- `@modelcontextprotocol/sdk` 현재 `^1.0.0` → 안정 최신 **1.29.0**.
  - 1.x는 저수준 `Server` + `setRequestHandler` 대신 고수준 `McpServer` + `registerTool`(zod 스키마)를 권장.
  - peerDeps: `zod ^3.25 || ^4.0` 지원.
  - v2.0.0-alpha(`@modelcontextprotocol/server`)는 alpha라 채택하지 않음.
- `zod` 최신 **4.4.3** 채택 (SDK 1.29가 지원).

## 변경 범위

### 1. 의존성 (`package.json`)

| 패키지 | 현재 | 변경 후 |
|---|---|---|
| `@modelcontextprotocol/sdk` | `^1.0.0` | `^1.29.0` |
| `@xenova/transformers` | `^2.17.2` | **제거** |
| `@huggingface/transformers` | — | `^4.2.0` (추가) |
| `zod` | — | `^4.4.3` (추가) |

모델 문자열 `Xenova/multilingual-e5-small` 유지 → 벡터 차원/분포 동일 → **기존 `.embedding` 파일 재생성 불필요**.

### 2. 임베딩 (`src/embeddings.ts`)

`getExtractor()` 내부 동적 import만 교체:

```ts
const { pipeline, env } = await import('@huggingface/transformers');
```

- `env.cacheDir`, `pipeline('feature-extraction', MODEL)`, `{ pooling: 'mean', normalize: true }` 호출 동일.
- 가능하면 `any` 타입을 v4가 export하는 파이프라인 타입으로 좁힌다. 불가하면 기존 유지.

### 3. 서버 (`src/server.ts`)

저수준 `Server` + `setRequestHandler(ListTools/CallTool)` → 고수준 `McpServer` + `registerTool`로 전환.

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'private-journal-mcp', version: '0.1.0' });
server.registerTool('write_journal', { description, inputSchema: { /* zod */ } }, handler);
// search_journal / read_journal / list_journal 동일 패턴
```

- 비즈니스 로직(`handleWrite`/`handleSearch`/`handleRead`/`handleList`)은 **그대로 유지** — 등록 레이어만 교체.
- 수동 JSON Schema → zod 스키마. zod 추론으로 `as unknown as ...` 캐스팅 제거.
- 4개 도구 이름/description/동작 보존.
- `run()`의 `ensureRepo`/`backfill` best-effort 및 transport 연결 로직 동일.

inputSchema 매핑:
- `write_journal`: `SECTION_KEYS` 각각 `z.string().optional()`
- `search_journal`: `query: z.string()`, `limit: z.number().optional()`, `sections: z.array(z.string()).optional()`
- `read_journal`: `path: z.string()`
- `list_journal`: `limit: z.number().optional()`, `days: z.number().optional()`

## 영향 없는 부분

- `journal.ts`, `git-sync.ts`, `search.ts`, `paths.ts`, `types.ts`, `index.ts` 로직 변경 없음
  (단, `index.ts`/`server.ts`가 공유하는 import 경로가 바뀌면 반영).
- `.claude-plugin/plugin.json`, `hooks/hooks.json`, `.mcp.json` 변경 없음.

## 검증 기준

1. `npm install` → 신규 의존성 설치 성공
2. `npm run build` → 타입 에러 0
3. `npm test` → 기존 테스트 그린 (API 변경으로 import가 깨지면 테스트도 수정)
4. MCP 서버 기동 → `tools/list`에 4개 도구 노출, `search_journal` 1회 정상 응답
   → verify: 기존 e2e 또는 수동 stdio 호출
```
