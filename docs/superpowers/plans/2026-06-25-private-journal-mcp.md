# Private Journal MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude에게 로컬·프라이빗 저널링과 시맨틱 검색을 제공하고, 선택적으로 GitHub 자동 동기화하는 MCP 서버를 만든다.

**Architecture:** TypeScript/Node MCP 서버. 4개 도구(write/search/read/list_journal). user 단일 저장소를 XDG 경로에 두고, 각 항목은 `.md`(YAML frontmatter+6섹션) + `.embedding`(JSON) 쌍으로 저장. 로컬 임베딩(`Xenova/multilingual-e5-small`)으로 코사인 유사도 검색. git 동기화는 공유 모듈 `git-sync.ts`에 집중하여 서버(write 시 commit+push)와 CLI `sync`(pull)가 공유한다.

**Tech Stack:** TypeScript, Node.js 22, `@modelcontextprotocol/sdk`, `@xenova/transformers`, jest + ts-jest.

## Global Constraints

- 런타임: Node.js (테스트는 Node 22 기준). ESM 또는 CommonJS는 Task 1에서 확정(아래 CommonJS 채택).
- 저장소: **user 단일**. project 저널 / `type` 필터 없음.
- 데이터 경로 우선순위: `PRIVATE_JOURNAL_PATH` > `$XDG_DATA_HOME/private-journal` > `~/.local/share/private-journal`.
- 캐시 경로: `$XDG_CACHE_HOME/private-journal/models` > `~/.cache/private-journal/models`.
- 임베딩 모델: `Xenova/multilingual-e5-small` (384차원). 저장 시 `passage: ` prefix, 검색 시 `query: ` prefix. pooling=mean, normalize=true.
- 섹션 6종 순서 고정: reflections, observations, project_notes, user_context, technical_insights, world_knowledge.
- 파일 레이아웃: `{dataPath}/YYYY-MM-DD/HH-MM-SS-{micro}.md` (+ `.embedding`). `{micro}`=6자리.
- frontmatter: `title`, `date`(ISO), `timestamp`(epoch ms).
- Git 활성화 조건: env `PRIVATE_JOURNAL_GIT_REMOTE` 설정 시에만. 인증은 `gh`에 위임.
- 충돌 해소: 같은 파일명 충돌 시 frontmatter `timestamp` 최신 우선, 동점이면 로컬(ours) 우선.
- 모든 git/임베딩 실패는 best-effort (저널 저장을 막지 않음, stderr 로그).
- bin 이름: `private-journal-mcp`. 인자 없으면 MCP 서버(stdio), `sync` 인자면 동기화 1회.

---

### Task 1: 프로젝트 스캐폴딩 (package.json, tsconfig, jest, types)

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `jest.config.js`
- Create: `src/types.ts`
- Test: `test/types.test.ts`

**Interfaces:**
- Produces:
  - `SECTION_KEYS: readonly string[]` = 6 섹션 키 (순서 고정).
  - `SECTION_TITLES: Record<string,string>` (예: `reflections` → `"Reflections"`, `project_notes` → `"Project Notes"`).
  - `type SectionKey = typeof SECTION_KEYS[number]`
  - `interface JournalSections { reflections?: string; observations?: string; project_notes?: string; user_context?: string; technical_insights?: string; world_knowledge?: string; }`
  - `interface EmbeddingData { embedding: number[]; text: string; sections: string[]; timestamp: number; path: string; }`
  - `interface SearchResult { path: string; score: number; excerpt: string; sections: string[]; timestamp: number; }`
  - `interface RecentEntry { path: string; title: string; date: string; timestamp: number; sections: string[]; }`

- [ ] **Step 1: package.json 작성**

```json
{
  "name": "private-journal-mcp",
  "version": "0.1.0",
  "description": "Local, private journaling MCP server with multilingual semantic search",
  "bin": { "private-journal-mcp": "./dist/index.js" },
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "start": "node dist/index.js",
    "test": "jest",
    "test:watch": "jest --watch"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "@xenova/transformers": "^2.17.2"
  },
  "devDependencies": {
    "@types/jest": "^29.5.0",
    "@types/node": "^22.0.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.2.0",
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 2: tsconfig.json 작성**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "node",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": false,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "test"]
}
```

- [ ] **Step 3: jest.config.js 작성**

```js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/test/**/*.test.ts'],
};
```

- [ ] **Step 4: 의존성 설치**

Run: `npm install`
Expected: `node_modules/` 생성, 에러 없이 완료.

- [ ] **Step 5: types.test.ts 작성 (실패 테스트)**

```ts
import { SECTION_KEYS, SECTION_TITLES } from '../src/types';

describe('types', () => {
  it('has 6 section keys in fixed order', () => {
    expect(SECTION_KEYS).toEqual([
      'reflections', 'observations', 'project_notes',
      'user_context', 'technical_insights', 'world_knowledge',
    ]);
  });

  it('maps each key to a heading title', () => {
    expect(SECTION_TITLES.reflections).toBe('Reflections');
    expect(SECTION_TITLES.project_notes).toBe('Project Notes');
    expect(SECTION_TITLES.world_knowledge).toBe('World Knowledge');
    expect(Object.keys(SECTION_TITLES)).toHaveLength(6);
  });
});
```

- [ ] **Step 6: 테스트 실패 확인**

Run: `npx jest test/types.test.ts`
Expected: FAIL — `Cannot find module '../src/types'`.

- [ ] **Step 7: src/types.ts 작성**

```ts
export const SECTION_KEYS = [
  'reflections',
  'observations',
  'project_notes',
  'user_context',
  'technical_insights',
  'world_knowledge',
] as const;

export type SectionKey = (typeof SECTION_KEYS)[number];

export const SECTION_TITLES: Record<SectionKey, string> = {
  reflections: 'Reflections',
  observations: 'Observations',
  project_notes: 'Project Notes',
  user_context: 'User Context',
  technical_insights: 'Technical Insights',
  world_knowledge: 'World Knowledge',
};

export type JournalSections = Partial<Record<SectionKey, string>>;

export interface EmbeddingData {
  embedding: number[];
  text: string;
  sections: string[];
  timestamp: number;
  path: string;
}

export interface SearchResult {
  path: string;
  score: number;
  excerpt: string;
  sections: string[];
  timestamp: number;
}

export interface RecentEntry {
  path: string;
  title: string;
  date: string;
  timestamp: number;
  sections: string[];
}
```

- [ ] **Step 8: 테스트 통과 확인**

Run: `npx jest test/types.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json tsconfig.json jest.config.js src/types.ts test/types.test.ts
git commit -m "feat: 프로젝트 스캐폴딩 + 공유 타입"
```

---

### Task 2: 경로 해석 (paths.ts) — XDG 준수

**Files:**
- Create: `src/paths.ts`
- Test: `test/paths.test.ts`

**Interfaces:**
- Consumes: 없음.
- Produces:
  - `resolveDataPath(env?: NodeJS.ProcessEnv): string` — 데이터 디렉토리 절대경로.
  - `resolveModelCachePath(env?: NodeJS.ProcessEnv): string` — 모델 캐시 절대경로.
  - 두 함수 모두 `env` 미전달 시 `process.env` 사용. 디렉토리를 만들지는 않음(경로 문자열만 반환).

- [ ] **Step 1: paths.test.ts 작성 (실패 테스트)**

```ts
import { resolveDataPath, resolveModelCachePath } from '../src/paths';
import * as path from 'path';

describe('resolveDataPath', () => {
  it('honors PRIVATE_JOURNAL_PATH above all', () => {
    const env = { PRIVATE_JOURNAL_PATH: '/custom/journal', XDG_DATA_HOME: '/xdg', HOME: '/home/u' };
    expect(resolveDataPath(env)).toBe('/custom/journal');
  });

  it('uses XDG_DATA_HOME when PRIVATE_JOURNAL_PATH unset', () => {
    const env = { XDG_DATA_HOME: '/xdg/data', HOME: '/home/u' };
    expect(resolveDataPath(env)).toBe(path.join('/xdg/data', 'private-journal'));
  });

  it('falls back to ~/.local/share', () => {
    const env = { HOME: '/home/u' };
    expect(resolveDataPath(env)).toBe(path.join('/home/u', '.local', 'share', 'private-journal'));
  });
});

describe('resolveModelCachePath', () => {
  it('uses XDG_CACHE_HOME when set', () => {
    const env = { XDG_CACHE_HOME: '/xdg/cache', HOME: '/home/u' };
    expect(resolveModelCachePath(env)).toBe(path.join('/xdg/cache', 'private-journal', 'models'));
  });

  it('falls back to ~/.cache', () => {
    const env = { HOME: '/home/u' };
    expect(resolveModelCachePath(env)).toBe(path.join('/home/u', '.cache', 'private-journal', 'models'));
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest test/paths.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: src/paths.ts 작성**

```ts
import * as path from 'path';
import * as os from 'os';

function homeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME || env.USERPROFILE || os.homedir();
}

export function resolveDataPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PRIVATE_JOURNAL_PATH) return env.PRIVATE_JOURNAL_PATH;
  if (env.XDG_DATA_HOME) return path.join(env.XDG_DATA_HOME, 'private-journal');
  return path.join(homeDir(env), '.local', 'share', 'private-journal');
}

export function resolveModelCachePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.XDG_CACHE_HOME) return path.join(env.XDG_CACHE_HOME, 'private-journal', 'models');
  return path.join(homeDir(env), '.cache', 'private-journal', 'models');
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest test/paths.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/paths.ts test/paths.test.ts
git commit -m "feat: XDG 기반 경로 해석"
```

---

### Task 3: 마크다운 직렬화/파싱 + 파일명 생성 (journal.ts 일부)

이 task는 순수 함수(파일 I/O 없음)만 다룬다. 실제 디스크 쓰기는 Task 4.

**Files:**
- Create: `src/journal.ts`
- Test: `test/journal.format.test.ts`

**Interfaces:**
- Consumes: `SECTION_KEYS`, `SECTION_TITLES`, `JournalSections` from `src/types`.
- Produces:
  - `renderEntry(sections: JournalSections, when: Date): string` — frontmatter+섹션 마크다운 문자열.
  - `parseFrontmatter(md: string): { title: string; date: string; timestamp: number }` — frontmatter 파싱.
  - `parseSections(md: string): string[]` — 존재하는 섹션 키 목록(소문자 키) 반환.
  - `buildEntryRelPath(when: Date): string` — `YYYY-MM-DD/HH-MM-SS-{micro}.md` (micro=6자리).

- [ ] **Step 1: journal.format.test.ts 작성 (실패 테스트)**

```ts
import { renderEntry, parseFrontmatter, parseSections, buildEntryRelPath } from '../src/journal';

const when = new Date('2026-06-25T12:34:56.789Z');

describe('renderEntry', () => {
  it('writes frontmatter and sections in fixed order', () => {
    const md = renderEntry(
      { observations: 'saw a bug', reflections: 'felt good' },
      when,
    );
    expect(md).toContain('timestamp: ' + when.getTime());
    expect(md).toContain('date: ' + when.toISOString());
    // reflections must appear before observations (fixed order)
    expect(md.indexOf('## Reflections')).toBeLessThan(md.indexOf('## Observations'));
    expect(md).toContain('felt good');
    expect(md).toContain('saw a bug');
  });

  it('omits sections not provided', () => {
    const md = renderEntry({ reflections: 'x' }, when);
    expect(md).not.toContain('## Observations');
  });
});

describe('parseFrontmatter', () => {
  it('round-trips with renderEntry', () => {
    const md = renderEntry({ reflections: 'x' }, when);
    const fm = parseFrontmatter(md);
    expect(fm.timestamp).toBe(when.getTime());
    expect(fm.date).toBe(when.toISOString());
  });
});

describe('parseSections', () => {
  it('lists present section keys', () => {
    const md = renderEntry({ reflections: 'x', project_notes: 'y' }, when);
    expect(parseSections(md).sort()).toEqual(['project_notes', 'reflections']);
  });
});

describe('buildEntryRelPath', () => {
  it('produces YYYY-MM-DD/HH-MM-SS-<6digits>.md', () => {
    const rel = buildEntryRelPath(when);
    expect(rel).toMatch(/^\d{4}-\d{2}-\d{2}\/\d{2}-\d{2}-\d{2}-\d{6}\.md$/);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest test/journal.format.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: src/journal.ts 작성 (순수 함수 부분)**

```ts
import { SECTION_KEYS, SECTION_TITLES, SectionKey, JournalSections } from './types';

function pad(n: number, len = 2): string {
  return String(n).padStart(len, '0');
}

const MONTHS = ['January','February','March','April','May','June','July',
  'August','September','October','November','December'];

export function renderEntry(sections: JournalSections, when: Date): string {
  const hh = pad(when.getHours());
  const mm = pad(when.getMinutes());
  const ss = pad(when.getSeconds());
  const title = `${hh}:${mm}:${ss} - ${MONTHS[when.getMonth()]} ${when.getDate()}, ${when.getFullYear()}`;
  const lines: string[] = [
    '---',
    `title: "${title}"`,
    `date: ${when.toISOString()}`,
    `timestamp: ${when.getTime()}`,
    '---',
    '',
  ];
  for (const key of SECTION_KEYS) {
    const val = sections[key as SectionKey];
    if (val && val.trim().length > 0) {
      lines.push(`## ${SECTION_TITLES[key as SectionKey]}`, '', val.trim(), '');
    }
  }
  return lines.join('\n');
}

export function parseFrontmatter(md: string): { title: string; date: string; timestamp: number } {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  const body = m ? m[1] : '';
  const title = (body.match(/title:\s*"?(.*?)"?\s*$/m) || [])[1] || '';
  const date = (body.match(/date:\s*(.*?)\s*$/m) || [])[1] || '';
  const ts = parseInt((body.match(/timestamp:\s*(\d+)/) || [])[1] || '0', 10);
  return { title, date, timestamp: ts };
}

export function parseSections(md: string): string[] {
  const present: string[] = [];
  for (const key of SECTION_KEYS) {
    if (md.includes(`## ${SECTION_TITLES[key as SectionKey]}`)) present.push(key);
  }
  return present;
}

export function buildEntryRelPath(when: Date): string {
  const y = when.getFullYear();
  const mo = pad(when.getMonth() + 1);
  const d = pad(when.getDate());
  const hh = pad(when.getHours());
  const mm = pad(when.getMinutes());
  const ss = pad(when.getSeconds());
  const micro = pad(when.getMilliseconds() * 1000 + Math.floor(Math.random() * 1000), 6);
  return `${y}-${mo}-${d}/${hh}-${mm}-${ss}-${micro}.md`;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest test/journal.format.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/journal.ts test/journal.format.test.ts
git commit -m "feat: 저널 마크다운 직렬화/파싱 + 파일명 생성"
```

---

### Task 4: 임베딩 서비스 (embeddings.ts)

모델 로드는 무겁고 외부 다운로드를 동반하므로, 순수 로직(코사인 유사도, 텍스트 추출, 저장/로드)만 단위 테스트하고 모델 추론은 인터페이스로 격리한다.

**Files:**
- Create: `src/embeddings.ts`
- Test: `test/embeddings.test.ts`

**Interfaces:**
- Consumes: `EmbeddingData` from `src/types`, `resolveModelCachePath` from `src/paths`.
- Produces (class `EmbeddingService`, 싱글톤):
  - `static getInstance(): EmbeddingService`
  - `cosineSimilarity(a: number[], b: number[]): number` (정적/인스턴스 무관, 순수)
  - `extractSearchableText(md: string): string` — frontmatter 제거 후 본문 텍스트.
  - `async saveEmbedding(mdPath: string, data: EmbeddingData): Promise<void>` — `.md`→`.embedding` 경로에 JSON 저장.
  - `async loadEmbedding(mdPath: string): Promise<EmbeddingData | null>`
  - `async generateEmbedding(text: string, kind: 'passage' | 'query'): Promise<number[]>` — E5 prefix 적용 후 모델 추론(첫 호출 시 lazy 로드, 30초 타임아웃). 단위 테스트에서는 호출하지 않음.
  - `embeddingPathFor(mdPath: string): string` — `.md`→`.embedding`.

- [ ] **Step 1: embeddings.test.ts 작성 (실패 테스트, 모델 추론 제외)**

```ts
import { EmbeddingService } from '../src/embeddings';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const svc = EmbeddingService.getInstance();

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(svc.cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });
  it('returns 0 for orthogonal vectors', () => {
    expect(svc.cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });
});

describe('extractSearchableText', () => {
  it('strips frontmatter and headings markers', () => {
    const md = '---\ntitle: "t"\ndate: d\ntimestamp: 1\n---\n\n## Reflections\n\nhello world\n';
    const text = svc.extractSearchableText(md);
    expect(text).toContain('hello world');
    expect(text).not.toContain('timestamp');
    expect(text).not.toContain('---');
  });
});

describe('embeddingPathFor', () => {
  it('swaps .md for .embedding', () => {
    expect(svc.embeddingPathFor('/a/b/c.md')).toBe('/a/b/c.embedding');
  });
});

describe('save/loadEmbedding', () => {
  it('round-trips embedding data', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emb-'));
    const mdPath = path.join(dir, 'x.md');
    const data = { embedding: [0.1, 0.2], text: 't', sections: ['reflections'], timestamp: 5, path: mdPath };
    await svc.saveEmbedding(mdPath, data);
    const loaded = await svc.loadEmbedding(mdPath);
    expect(loaded).toEqual(data);
  });
  it('returns null when embedding file missing', async () => {
    expect(await svc.loadEmbedding('/no/such/file.md')).toBeNull();
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest test/embeddings.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: src/embeddings.ts 작성**

```ts
import * as fs from 'fs/promises';
import { EmbeddingData } from './types';
import { resolveModelCachePath } from './paths';

const MODEL = 'Xenova/multilingual-e5-small';
const LOAD_TIMEOUT_MS = 30_000;

export class EmbeddingService {
  private static instance: EmbeddingService;
  private extractor: any | null = null;
  private loading: Promise<any> | null = null;

  static getInstance(): EmbeddingService {
    if (!EmbeddingService.instance) EmbeddingService.instance = new EmbeddingService();
    return EmbeddingService.instance;
  }

  cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  extractSearchableText(md: string): string {
    const withoutFm = md.replace(/^---\n[\s\S]*?\n---\n?/, '');
    return withoutFm.replace(/^##\s+/gm, '').trim();
  }

  embeddingPathFor(mdPath: string): string {
    return mdPath.replace(/\.md$/, '.embedding');
  }

  async saveEmbedding(mdPath: string, data: EmbeddingData): Promise<void> {
    await fs.writeFile(this.embeddingPathFor(mdPath), JSON.stringify(data), 'utf8');
  }

  async loadEmbedding(mdPath: string): Promise<EmbeddingData | null> {
    try {
      const raw = await fs.readFile(this.embeddingPathFor(mdPath), 'utf8');
      return JSON.parse(raw) as EmbeddingData;
    } catch {
      return null;
    }
  }

  private async getExtractor(): Promise<any> {
    if (this.extractor) return this.extractor;
    if (!this.loading) {
      this.loading = (async () => {
        const { pipeline, env } = await import('@xenova/transformers');
        env.cacheDir = resolveModelCachePath();
        const timeout = new Promise((_, rej) =>
          setTimeout(() => rej(new Error('embedding model load timed out')), LOAD_TIMEOUT_MS),
        );
        this.extractor = await Promise.race([
          pipeline('feature-extraction', MODEL),
          timeout,
        ]);
        return this.extractor;
      })();
    }
    return this.loading;
  }

  async generateEmbedding(text: string, kind: 'passage' | 'query'): Promise<number[]> {
    const extractor = await this.getExtractor();
    const prefixed = `${kind}: ${text}`;
    const output = await extractor(prefixed, { pooling: 'mean', normalize: true });
    return Array.from(output.data as Float32Array);
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest test/embeddings.test.ts`
Expected: PASS (6 tests). 모델 다운로드는 발생하지 않음(generateEmbedding 미호출).

- [ ] **Step 5: Commit**

```bash
git add src/embeddings.ts test/embeddings.test.ts
git commit -m "feat: 임베딩 서비스(코사인/텍스트추출/저장로드 + E5 prefix)"
```

---

### Task 5: 저널 쓰기 (JournalManager — 디스크 I/O)

**Files:**
- Modify: `src/journal.ts` (클래스 `JournalManager` 추가)
- Test: `test/journal.write.test.ts`

**Interfaces:**
- Consumes: `renderEntry`, `buildEntryRelPath`, `parseSections` (같은 파일), `EmbeddingService`, `JournalSections`, `EmbeddingData`.
- Produces (class `JournalManager`):
  - `constructor(dataPath: string, embeddings: EmbeddingService)`
  - `async write(sections: JournalSections, when?: Date): Promise<string>` — `.md` 작성 후 절대경로 반환. 임베딩 생성은 best-effort(실패해도 `.md` 경로 반환). 디렉토리 자동 생성.
  - `hasContent(sections: JournalSections): boolean` — 최소 1개 섹션이 비어있지 않은지.

- [ ] **Step 1: journal.write.test.ts 작성 (실패 테스트)**

embeddings는 모델 다운로드를 피하기 위해 generateEmbedding을 jest로 스텁한다.

```ts
import { JournalManager } from '../src/journal';
import { EmbeddingService } from '../src/embeddings';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('JournalManager.write', () => {
  it('writes .md and .embedding under dated dir', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jm-'));
    const emb = EmbeddingService.getInstance();
    jest.spyOn(emb, 'generateEmbedding').mockResolvedValue([0.1, 0.2, 0.3]);

    const jm = new JournalManager(dir, emb);
    const when = new Date('2026-06-25T01:02:03.000Z');
    const mdPath = await jm.write({ reflections: '오늘의 회고' }, when);

    expect(mdPath.endsWith('.md')).toBe(true);
    const md = await fs.readFile(mdPath, 'utf8');
    expect(md).toContain('오늘의 회고');

    const embPath = mdPath.replace(/\.md$/, '.embedding');
    const embData = JSON.parse(await fs.readFile(embPath, 'utf8'));
    expect(embData.sections).toContain('reflections');
    expect(embData.embedding).toEqual([0.1, 0.2, 0.3]);
  });

  it('hasContent is false when all sections empty', () => {
    const jm = new JournalManager('/tmp', EmbeddingService.getInstance());
    expect(jm.hasContent({})).toBe(false);
    expect(jm.hasContent({ reflections: '   ' })).toBe(false);
    expect(jm.hasContent({ reflections: 'x' })).toBe(true);
  });

  it('still returns md path if embedding generation fails', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jm-'));
    const emb = EmbeddingService.getInstance();
    jest.spyOn(emb, 'generateEmbedding').mockRejectedValue(new Error('model fail'));
    const jm = new JournalManager(dir, emb);
    const mdPath = await jm.write({ reflections: 'x' });
    expect(mdPath.endsWith('.md')).toBe(true);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest test/journal.write.test.ts`
Expected: FAIL — `JournalManager is not a constructor`.

- [ ] **Step 3: src/journal.ts에 JournalManager 추가**

파일 하단에 append:

```ts
import * as fs from 'fs/promises';
import * as path from 'path';
import { EmbeddingService } from './embeddings';
import { EmbeddingData } from './types';

export class JournalManager {
  constructor(private dataPath: string, private embeddings: EmbeddingService) {}

  hasContent(sections: JournalSections): boolean {
    return SECTION_KEYS.some((k) => {
      const v = sections[k as SectionKey];
      return !!v && v.trim().length > 0;
    });
  }

  async write(sections: JournalSections, when: Date = new Date()): Promise<string> {
    const rel = buildEntryRelPath(when);
    const mdPath = path.join(this.dataPath, rel);
    await fs.mkdir(path.dirname(mdPath), { recursive: true });
    const md = renderEntry(sections, when);
    await fs.writeFile(mdPath, md, 'utf8');

    try {
      const presentSections = parseSections(md);
      const text = this.embeddings.extractSearchableText(md);
      const vector = await this.embeddings.generateEmbedding(text, 'passage');
      const data: EmbeddingData = {
        embedding: vector,
        text,
        sections: presentSections,
        timestamp: when.getTime(),
        path: mdPath,
      };
      await this.embeddings.saveEmbedding(mdPath, data);
    } catch (err) {
      console.error('[private-journal] embedding generation failed:', err);
    }

    return mdPath;
  }
}
```

위 코드 블록의 `import` 5줄(`fs`, `path`, `EmbeddingService`, `EmbeddingData`)은 파일 **상단**(Task 3에서 작성한 `import { ... } from './types';` 바로 아래)으로 옮겨 모은다. 클래스 본문만 파일 하단에 둔다. 같은 모듈을 두 번 import하지 않도록 주의.

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest test/journal.write.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: 전체 테스트 회귀 확인**

Run: `npx jest`
Expected: 지금까지 모든 테스트 PASS.

- [ ] **Step 6: Commit**

```bash
git add src/journal.ts test/journal.write.test.ts
git commit -m "feat: JournalManager 디스크 쓰기 + 임베딩 best-effort"
```

---

### Task 6: 검색 / 최근 목록 / 백필 (search.ts)

**Files:**
- Create: `src/search.ts`
- Test: `test/search.test.ts`

**Interfaces:**
- Consumes: `EmbeddingService`, `parseFrontmatter`, `parseSections` (from journal), `SearchResult`, `RecentEntry`.
- Produces (class `SearchService`):
  - `constructor(dataPath: string, embeddings: EmbeddingService)`
  - `async listEntryFiles(): Promise<string[]>` — 데이터 경로 하위 모든 `.md` 절대경로(없으면 빈 배열).
  - `async search(query: string, opts?: { limit?: number; sections?: string[] }): Promise<SearchResult[]>` — query를 `query` prefix로 임베딩, 각 `.embedding`과 코사인 유사도 상위 limit(기본 10). sections 필터: 결과 항목의 sections와 교집합이 있어야 통과.
  - `async listRecent(opts?: { limit?: number; days?: number }): Promise<RecentEntry[]>` — frontmatter 기준 최근 limit(기본 10)개, days(기본 30) 이내. timestamp 내림차순.
  - `async backfill(): Promise<number>` — `.md` 있고 `.embedding` 없는 항목 생성, 생성 개수 반환. 개별 실패는 무시(로그).

- [ ] **Step 1: search.test.ts 작성 (실패 테스트)**

generateEmbedding을 스텁하여 결정적 벡터를 준다.

```ts
import { SearchService } from '../src/search';
import { JournalManager } from '../src/journal';
import { EmbeddingService } from '../src/embeddings';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

async function seed() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srch-'));
  const emb = EmbeddingService.getInstance();
  const jm = new JournalManager(dir, emb);
  // deterministic vectors: "cat" entry -> [1,0]; "dog" entry -> [0,1]
  jest.spyOn(emb, 'generateEmbedding').mockImplementation(async (text: string) => {
    if (text.includes('고양이')) return [1, 0];
    return [0, 1];
  });
  await jm.write({ reflections: '고양이에 대한 기록' }, new Date('2026-06-20T10:00:00Z'));
  await jm.write({ observations: '강아지 관찰' }, new Date('2026-06-24T10:00:00Z'));
  return { dir, emb };
}

describe('SearchService.search', () => {
  it('ranks the semantically closest entry first', async () => {
    const { dir, emb } = await seed();
    jest.spyOn(emb, 'generateEmbedding').mockResolvedValue([1, 0]); // query ~ cat
    const svc = new SearchService(dir, emb);
    const results = await svc.search('고양이', { limit: 5 });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].path).toContain('2026-06-20');
    expect(results[0].score).toBeGreaterThan(results[results.length - 1].score - 0.0001);
  });

  it('filters by sections', async () => {
    const { dir, emb } = await seed();
    jest.spyOn(emb, 'generateEmbedding').mockResolvedValue([0, 1]);
    const svc = new SearchService(dir, emb);
    const results = await svc.search('강아지', { sections: ['observations'] });
    expect(results.every(r => r.sections.includes('observations'))).toBe(true);
  });
});

describe('SearchService.listRecent', () => {
  it('returns entries newest-first', async () => {
    const { dir, emb } = await seed();
    const svc = new SearchService(dir, emb);
    const recent = await svc.listRecent({ limit: 10, days: 3650 });
    expect(recent[0].timestamp).toBeGreaterThan(recent[1].timestamp);
  });
});

describe('SearchService.backfill', () => {
  it('creates missing .embedding files', async () => {
    const { dir, emb } = await seed();
    // delete one embedding
    const files: string[] = [];
    async function walk(d: string) {
      for (const e of await fs.readdir(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.name.endsWith('.embedding')) files.push(p);
      }
    }
    await walk(dir);
    await fs.unlink(files[0]);
    jest.spyOn(emb, 'generateEmbedding').mockResolvedValue([0.5, 0.5]);
    const svc = new SearchService(dir, emb);
    const n = await svc.backfill();
    expect(n).toBe(1);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest test/search.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: src/search.ts 작성**

```ts
import * as fs from 'fs/promises';
import * as path from 'path';
import { EmbeddingService } from './embeddings';
import { parseFrontmatter, parseSections } from './journal';
import { SearchResult, RecentEntry, EmbeddingData } from './types';

export class SearchService {
  constructor(private dataPath: string, private embeddings: EmbeddingService) {}

  async listEntryFiles(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === '.git') continue;
          await walk(p);
        } else if (e.name.endsWith('.md')) {
          out.push(p);
        }
      }
    };
    await walk(this.dataPath);
    return out;
  }

  async search(query: string, opts: { limit?: number; sections?: string[] } = {}): Promise<SearchResult[]> {
    const limit = opts.limit ?? 10;
    const qVec = await this.embeddings.generateEmbedding(query, 'query');
    const files = await this.listEntryFiles();
    const scored: SearchResult[] = [];
    for (const mdPath of files) {
      const data = await this.embeddings.loadEmbedding(mdPath);
      if (!data) continue;
      if (opts.sections && opts.sections.length > 0) {
        const overlap = data.sections.some((s) => opts.sections!.includes(s));
        if (!overlap) continue;
      }
      const score = this.embeddings.cosineSimilarity(qVec, data.embedding);
      scored.push({
        path: mdPath,
        score,
        excerpt: data.text.slice(0, 200),
        sections: data.sections,
        timestamp: data.timestamp,
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  async listRecent(opts: { limit?: number; days?: number } = {}): Promise<RecentEntry[]> {
    const limit = opts.limit ?? 10;
    const days = opts.days ?? 30;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const files = await this.listEntryFiles();
    const entries: RecentEntry[] = [];
    for (const mdPath of files) {
      const md = await fs.readFile(mdPath, 'utf8');
      const fm = parseFrontmatter(md);
      if (fm.timestamp < cutoff) continue;
      entries.push({
        path: mdPath,
        title: fm.title,
        date: fm.date,
        timestamp: fm.timestamp,
        sections: parseSections(md),
      });
    }
    entries.sort((a, b) => b.timestamp - a.timestamp);
    return entries.slice(0, limit);
  }

  async backfill(): Promise<number> {
    const files = await this.listEntryFiles();
    let created = 0;
    for (const mdPath of files) {
      const existing = await this.embeddings.loadEmbedding(mdPath);
      if (existing) continue;
      try {
        const md = await fs.readFile(mdPath, 'utf8');
        const fm = parseFrontmatter(md);
        const text = this.embeddings.extractSearchableText(md);
        const vector = await this.embeddings.generateEmbedding(text, 'passage');
        const data: EmbeddingData = {
          embedding: vector,
          text,
          sections: parseSections(md),
          timestamp: fm.timestamp,
          path: mdPath,
        };
        await this.embeddings.saveEmbedding(mdPath, data);
        created++;
      } catch (err) {
        console.error('[private-journal] backfill failed for', mdPath, err);
      }
    }
    return created;
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest test/search.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/search.ts test/search.test.ts
git commit -m "feat: 검색/최근목록/백필 SearchService"
```

---

### Task 7: Git 동기화 (git-sync.ts)

git 명령은 `child_process.execFile`로 호출한다. 충돌 해소(timestamp 비교)는 순수 함수로 분리해 단위 테스트하고, 실제 git 흐름은 임시 로컬 repo로 통합 테스트한다.

**Files:**
- Create: `src/git-sync.ts`
- Test: `test/git-sync.test.ts`

**Interfaces:**
- Consumes: `parseFrontmatter` from journal.
- Produces:
  - `chooseConflictWinner(oursMd: string, theirsMd: string): 'ours' | 'theirs'` — 순수 함수. frontmatter timestamp 비교, theirs가 더 크면 'theirs', 아니면(같거나 작으면) 'ours'.
  - `class GitSync`:
    - `constructor(dataPath: string, remote: string | undefined)`
    - `get enabled(): boolean` — remote 설정 여부.
    - `async ensureRepo(): Promise<void>` — `.git` 없으면 원격 ls-remote로 내용 확인 후 clone, 비었으면 init+remote add. (disabled면 no-op)
    - `async pull(): Promise<void>` — `git pull --rebase --autostash`, 충돌 시 해소 후 continue. (disabled면 no-op)
    - `async commitAndPush(message: string): Promise<void>` — add→commit→pull→push, push 거부 시 1회 재시도. 전 과정 best-effort(throw 안 함, 로그만). (disabled면 no-op)

- [ ] **Step 1: git-sync.test.ts 작성 (실패 테스트)**

순수 함수 + 실제 로컬 repo 통합. `execFile`로 git을 직접 부른다.

```ts
import { chooseConflictWinner, GitSync } from '../src/git-sync';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const run = promisify(execFile);

function md(ts: number, body = 'x') {
  return `---\ntitle: "t"\ndate: d\ntimestamp: ${ts}\n---\n\n## Reflections\n\n${body}\n`;
}

describe('chooseConflictWinner', () => {
  it('picks theirs when their timestamp is newer', () => {
    expect(chooseConflictWinner(md(100), md(200))).toBe('theirs');
  });
  it('picks ours when timestamps are equal', () => {
    expect(chooseConflictWinner(md(100), md(100))).toBe('ours');
  });
  it('picks ours when ours is newer', () => {
    expect(chooseConflictWinner(md(300), md(200))).toBe('ours');
  });
});

describe('GitSync (disabled when no remote)', () => {
  it('is no-op when remote undefined', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-'));
    const gs = new GitSync(dir, undefined);
    expect(gs.enabled).toBe(false);
    await gs.ensureRepo();
    await gs.commitAndPush('msg'); // should not throw
    await expect(fs.access(path.join(dir, '.git'))).rejects.toBeDefined();
  });
});

describe('GitSync commitAndPush against a bare remote', () => {
  it('commits and pushes journal files', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'gsr-'));
    const remote = path.join(base, 'remote.git');
    const work = path.join(base, 'work');
    await run('git', ['init', '--bare', remote]);
    await fs.mkdir(work, { recursive: true });

    const gs = new GitSync(work, remote);
    await gs.ensureRepo();
    await fs.mkdir(path.join(work, '2026-06-25'), { recursive: true });
    await fs.writeFile(path.join(work, '2026-06-25', '01-02-03-000000.md'), md(123), 'utf8');
    await gs.commitAndPush('journal: test');

    // clone remote elsewhere and verify file present
    const verify = path.join(base, 'verify');
    await run('git', ['clone', remote, verify]);
    const exists = await fs.access(path.join(verify, '2026-06-25', '01-02-03-000000.md')).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest test/git-sync.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: src/git-sync.ts 작성**

```ts
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { parseFrontmatter } from './journal';

const run = promisify(execFile);

export function chooseConflictWinner(oursMd: string, theirsMd: string): 'ours' | 'theirs' {
  const ours = parseFrontmatter(oursMd).timestamp;
  const theirs = parseFrontmatter(theirsMd).timestamp;
  return theirs > ours ? 'theirs' : 'ours';
}

export class GitSync {
  constructor(private dataPath: string, private remote: string | undefined) {}

  get enabled(): boolean {
    return !!this.remote;
  }

  private async git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return run('git', args, { cwd: this.dataPath });
  }

  private async hasGitDir(): Promise<boolean> {
    return fs.access(path.join(this.dataPath, '.git')).then(() => true).catch(() => false);
  }

  async ensureRepo(): Promise<void> {
    if (!this.enabled) return;
    if (await this.hasGitDir()) return;
    await fs.mkdir(this.dataPath, { recursive: true });
    // does remote have any refs?
    let remoteHasContent = false;
    try {
      const { stdout } = await run('git', ['ls-remote', this.remote!]);
      remoteHasContent = stdout.trim().length > 0;
    } catch {
      remoteHasContent = false;
    }
    if (remoteHasContent) {
      // clone into temp then move .git + files in
      await this.git(['init']);
      await this.git(['remote', 'add', 'origin', this.remote!]);
      await this.git(['fetch', 'origin']);
      // determine default branch
      const branch = await this.defaultRemoteBranch();
      await this.git(['checkout', '-B', branch, `origin/${branch}`]);
    } else {
      await this.git(['init']);
      await this.git(['remote', 'add', 'origin', this.remote!]);
    }
  }

  private async defaultRemoteBranch(): Promise<string> {
    try {
      const { stdout } = await run('git', ['ls-remote', '--symref', this.remote!, 'HEAD']);
      const m = stdout.match(/ref:\s+refs\/heads\/(\S+)\s+HEAD/);
      if (m) return m[1];
    } catch { /* ignore */ }
    return 'main';
  }

  private async currentBranch(): Promise<string> {
    try {
      const { stdout } = await this.git(['rev-parse', '--abbrev-ref', 'HEAD']);
      const b = stdout.trim();
      if (b && b !== 'HEAD') return b;
    } catch { /* ignore */ }
    return 'main';
  }

  async pull(): Promise<void> {
    if (!this.enabled) return;
    if (!(await this.hasGitDir())) return;
    try {
      await this.git(['pull', '--rebase', '--autostash', 'origin', await this.currentBranch()]);
    } catch {
      await this.resolveRebaseConflicts();
    }
  }

  private async resolveRebaseConflicts(): Promise<void> {
    // loop until rebase done or unresolvable
    for (let i = 0; i < 100; i++) {
      let conflicted: string[] = [];
      try {
        const { stdout } = await this.git(['diff', '--name-only', '--diff-filter=U']);
        conflicted = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
      } catch {
        break;
      }
      if (conflicted.length === 0) break;
      for (const rel of conflicted) {
        if (rel.endsWith('.md')) {
          await this.resolveMdConflict(rel);
        } else {
          // .embedding or other: take ours, will be regenerated/ignored
          await this.git(['checkout', '--ours', '--', rel]).catch(() => {});
          await this.git(['add', '--', rel]).catch(() => {});
        }
      }
      try {
        await this.git(['rebase', '--continue']);
        break;
      } catch {
        // more conflicts in next commit; loop again
        continue;
      }
    }
  }

  private async resolveMdConflict(rel: string): Promise<void> {
    let oursMd = '';
    let theirsMd = '';
    try {
      oursMd = (await this.git(['show', `:2:${rel}`])).stdout;
    } catch { /* ours may not exist */ }
    try {
      theirsMd = (await this.git(['show', `:3:${rel}`])).stdout;
    } catch { /* theirs may not exist */ }
    const winner = chooseConflictWinner(oursMd, theirsMd);
    const side = winner === 'ours' ? '--ours' : '--theirs';
    await this.git(['checkout', side, '--', rel]).catch(() => {});
    await this.git(['add', '--', rel]).catch(() => {});
  }

  async commitAndPush(message: string): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.ensureRepo();
      await this.git(['add', '-A']);
      // commit may fail if nothing to commit; tolerate
      try {
        await this.git(['commit', '-m', message]);
      } catch {
        return; // nothing to commit
      }
      const branch = await this.currentBranch();
      for (let attempt = 0; attempt < 2; attempt++) {
        await this.pull();
        try {
          await this.git(['push', '-u', 'origin', branch]);
          return;
        } catch (err) {
          if (attempt === 1) {
            console.error('[private-journal] git push failed (best-effort):', err);
          }
        }
      }
    } catch (err) {
      console.error('[private-journal] git sync failed (best-effort):', err);
    }
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest test/git-sync.test.ts`
Expected: PASS. (로컬 git 사용, gh 불필요 — 로컬 bare remote 경로 사용.)

- [ ] **Step 5: Commit**

```bash
git add src/git-sync.ts test/git-sync.test.ts
git commit -m "feat: git 동기화(충돌 해소 timestamp 최신 우선)"
```

---

### Task 8: MCP 서버 + 4개 도구 (server.ts)

**Files:**
- Create: `src/server.ts`
- Test: `test/server.test.ts`

**Interfaces:**
- Consumes: `JournalManager`, `SearchService`, `EmbeddingService`, `GitSync`, `resolveDataPath`, `SECTION_KEYS`.
- Produces:
  - `class PrivateJournalServer`:
    - `constructor(opts?: { dataPath?: string; remote?: string })`
    - `async handleWrite(args: JournalSections): Promise<{ path: string }>` — 검증(hasContent) 후 write, git commitAndPush(best-effort).
    - `async handleSearch(args): Promise<SearchResult[]>`
    - `async handleRead(args: { path: string }): Promise<{ content: string }>`
    - `async handleList(args): Promise<RecentEntry[]>`
    - `async run(): Promise<void>` — backfill(best-effort) 후 stdio transport 연결, 4개 도구 등록.

핸들러 로직을 메서드로 노출해 MCP transport 없이 단위 테스트한다.

- [ ] **Step 1: server.test.ts 작성 (실패 테스트, 핸들러 단위)**

```ts
import { PrivateJournalServer } from '../src/server';
import { EmbeddingService } from '../src/embeddings';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('PrivateJournalServer handlers', () => {
  it('handleWrite rejects empty input', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srv-'));
    const srv = new PrivateJournalServer({ dataPath: dir });
    await expect(srv.handleWrite({})).rejects.toThrow();
  });

  it('write then read returns content', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srv-'));
    jest.spyOn(EmbeddingService.getInstance(), 'generateEmbedding').mockResolvedValue([0.1, 0.2]);
    const srv = new PrivateJournalServer({ dataPath: dir });
    const { path: p } = await srv.handleWrite({ reflections: '회고 내용' });
    const { content } = await srv.handleRead({ path: p });
    expect(content).toContain('회고 내용');
  });

  it('handleList returns the written entry', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srv-'));
    jest.spyOn(EmbeddingService.getInstance(), 'generateEmbedding').mockResolvedValue([0.1, 0.2]);
    const srv = new PrivateJournalServer({ dataPath: dir });
    await srv.handleWrite({ observations: '관찰' });
    const list = await srv.handleList({ days: 3650 });
    expect(list.length).toBe(1);
    expect(list[0].sections).toContain('observations');
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest test/server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: src/server.ts 작성**

```ts
import * as fs from 'fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { EmbeddingService } from './embeddings';
import { JournalManager } from './journal';
import { SearchService } from './search';
import { GitSync } from './git-sync';
import { resolveDataPath } from './paths';
import { JournalSections, SearchResult, RecentEntry } from './types';

export class PrivateJournalServer {
  private dataPath: string;
  private embeddings: EmbeddingService;
  private journal: JournalManager;
  private search: SearchService;
  private git: GitSync;

  constructor(opts: { dataPath?: string; remote?: string } = {}) {
    this.dataPath = opts.dataPath ?? resolveDataPath();
    this.embeddings = EmbeddingService.getInstance();
    this.journal = new JournalManager(this.dataPath, this.embeddings);
    this.search = new SearchService(this.dataPath, this.embeddings);
    this.git = new GitSync(this.dataPath, opts.remote ?? process.env.PRIVATE_JOURNAL_GIT_REMOTE);
  }

  async handleWrite(args: JournalSections): Promise<{ path: string }> {
    if (!this.journal.hasContent(args)) {
      throw new Error('At least one journal section must have content.');
    }
    const p = await this.journal.write(args);
    this.git.commitAndPush(`journal: ${new Date().toISOString()}`).catch((e) =>
      console.error('[private-journal] commitAndPush error:', e),
    );
    return { path: p };
  }

  async handleSearch(args: { query: string; limit?: number; sections?: string[] }): Promise<SearchResult[]> {
    return this.search.search(args.query, { limit: args.limit, sections: args.sections });
  }

  async handleRead(args: { path: string }): Promise<{ content: string }> {
    const content = await fs.readFile(args.path, 'utf8');
    return { content };
  }

  async handleList(args: { limit?: number; days?: number }): Promise<RecentEntry[]> {
    return this.search.listRecent({ limit: args.limit, days: args.days });
  }

  async run(): Promise<void> {
    await this.git.ensureRepo().catch((e) => console.error('[private-journal] ensureRepo:', e));
    await this.search.backfill().catch((e) => console.error('[private-journal] backfill:', e));

    const server = new Server(
      { name: 'private-journal-mcp', version: '0.1.0' },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'write_journal',
          description: 'Write a private journal entry across optional sections.',
          inputSchema: {
            type: 'object',
            properties: {
              reflections: { type: 'string' },
              observations: { type: 'string' },
              project_notes: { type: 'string' },
              user_context: { type: 'string' },
              technical_insights: { type: 'string' },
              world_knowledge: { type: 'string' },
            },
          },
        },
        {
          name: 'search_journal',
          description: 'Semantic search across journal entries.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              limit: { type: 'number' },
              sections: { type: 'array', items: { type: 'string' } },
            },
            required: ['query'],
          },
        },
        {
          name: 'read_journal',
          description: 'Read the full content of a journal entry by path.',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
        {
          name: 'list_journal',
          description: 'List recent journal entries (metadata only).',
          inputSchema: {
            type: 'object',
            properties: { limit: { type: 'number' }, days: { type: 'number' } },
          },
        },
      ],
    }));

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const { name, arguments: a } = req.params;
      const args = (a ?? {}) as any;
      let result: unknown;
      switch (name) {
        case 'write_journal': result = await this.handleWrite(args); break;
        case 'search_journal': result = await this.handleSearch(args); break;
        case 'read_journal': result = await this.handleRead(args); break;
        case 'list_journal': result = await this.handleList(args); break;
        default: throw new Error(`Unknown tool: ${name}`);
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('[private-journal] MCP server running on stdio');
  }
}
```

> 주: `@modelcontextprotocol/sdk` 실제 import 경로/스키마 명은 설치된 버전(`^1.0.0`)에 맞춰 구현 시 확인한다. import가 다르면 빌드 에러로 즉시 드러나므로 Step 5 빌드에서 교정.

- [ ] **Step 4: 핸들러 테스트 통과 확인**

Run: `npx jest test/server.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: 타입체크/빌드 확인**

Run: `npm run build`
Expected: 에러 없이 `dist/` 생성. (SDK import 경로가 다르면 여기서 잡아 수정.)

- [ ] **Step 6: Commit**

```bash
git add src/server.ts test/server.test.ts
git commit -m "feat: MCP 서버 + 4개 도구"
```

---

### Task 9: 엔트리포인트 + CLI sync (index.ts)

**Files:**
- Create: `src/index.ts`
- Test: `test/index.test.ts`

**Interfaces:**
- Consumes: `PrivateJournalServer`, `GitSync`, `resolveDataPath`, `SearchService`, `EmbeddingService`.
- Produces:
  - `async function runSync(opts?: { dataPath?: string; remote?: string }): Promise<void>` — ensureRepo → pull → commitAndPush(밀린 변경) → backfill(best-effort). disabled면 조용히 종료.
  - `async function main(argv: string[]): Promise<void>` — `argv[2] === 'sync'`면 runSync, 아니면 `new PrivateJournalServer().run()`.
  - 파일 맨 아래 shebang `#!/usr/bin/env node` + `if (require.main === module) main(process.argv)`.

- [ ] **Step 1: index.test.ts 작성 (실패 테스트)**

```ts
import { runSync } from '../src/index';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('runSync', () => {
  it('is a no-op when remote is undefined (no .git created)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idx-'));
    await runSync({ dataPath: dir, remote: undefined });
    const hasGit = await fs.access(path.join(dir, '.git')).then(() => true).catch(() => false);
    expect(hasGit).toBe(false);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest test/index.test.ts`
Expected: FAIL — module not found / `runSync` 없음.

- [ ] **Step 3: src/index.ts 작성**

```ts
#!/usr/bin/env node
import { PrivateJournalServer } from './server';
import { GitSync } from './git-sync';
import { SearchService } from './search';
import { EmbeddingService } from './embeddings';
import { resolveDataPath } from './paths';

export async function runSync(opts: { dataPath?: string; remote?: string } = {}): Promise<void> {
  const dataPath = opts.dataPath ?? resolveDataPath();
  const remote = opts.remote ?? process.env.PRIVATE_JOURNAL_GIT_REMOTE;
  const git = new GitSync(dataPath, remote);
  if (!git.enabled) return;
  await git.ensureRepo();
  await git.pull();
  await git.commitAndPush(`journal sync: ${new Date().toISOString()}`);
  const search = new SearchService(dataPath, EmbeddingService.getInstance());
  await search.backfill().catch((e) => console.error('[private-journal] backfill:', e));
}

export async function main(argv: string[]): Promise<void> {
  if (argv[2] === 'sync') {
    await runSync();
    return;
  }
  await new PrivateJournalServer().run();
}

if (require.main === module) {
  main(process.argv).catch((err) => {
    console.error('[private-journal] fatal:', err);
    process.exit(1);
  });
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest test/index.test.ts`
Expected: PASS.

- [ ] **Step 5: 전체 테스트 + 빌드**

Run: `npx jest && npm run build`
Expected: 전체 PASS, 빌드 성공. `dist/index.js` 생성.

- [ ] **Step 6: dist/index.js 실행 권한 확인 및 smoke test**

Run: `node dist/index.js sync`
Expected: remote 미설정이면 즉시 무에러 종료 (no-op).

- [ ] **Step 7: Commit**

```bash
git add src/index.ts test/index.test.ts
git commit -m "feat: 엔트리포인트 + CLI sync 서브커맨드"
```

---

### Task 10: 통합 smoke test (실모델 1회) + README + hook 예시

이 task는 실제 임베딩 모델을 1회 다운로드/실행해 end-to-end가 도는지 확인하고(옵트인, 무거움), 사용 문서를 작성한다.

**Files:**
- Create: `README.md`
- Create: `test/e2e.manual.test.ts` (기본 skip, 환경변수로 옵트인)
- Modify: `.gitignore` (이미 있으면 확인)

**Interfaces:**
- Consumes: 전체.
- Produces: 문서 + 수동 e2e 테스트.

- [ ] **Step 1: e2e.manual.test.ts 작성 (옵트인)**

```ts
import { PrivateJournalServer } from '../src/server';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const RUN = process.env.RUN_E2E === '1';
(RUN ? describe : describe.skip)('e2e (real model)', () => {
  jest.setTimeout(120_000);
  it('write -> search finds the entry semantically', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-'));
    const srv = new PrivateJournalServer({ dataPath: dir });
    await srv.handleWrite({ reflections: '오늘 검색 추천 시스템의 랭킹 모델을 개선했다' });
    await srv.handleWrite({ observations: '날씨가 맑았다' });
    const results = await srv.handleSearch({ query: '랭킹 모델 개선', limit: 2 });
    expect(results[0].excerpt).toContain('랭킹');
  });
});
```

- [ ] **Step 2: 기본 실행 시 skip 확인**

Run: `npx jest test/e2e.manual.test.ts`
Expected: 1 skipped (모델 다운로드 없음).

- [ ] **Step 3: 옵트인 e2e 실행 (실모델, 1회)**

Run: `RUN_E2E=1 npx jest test/e2e.manual.test.ts`
Expected: 모델 다운로드 후 PASS. (실패 시 네트워크/모델 이슈 — 로그 확인. 통과해야 함.)

- [ ] **Step 4: README.md 작성**

````markdown
# private-journal-mcp

로컬·프라이빗 저널링과 다국어 시맨틱 검색을 제공하는 MCP 서버. 모든 처리는 로컬에서
일어나며 외부 API 호출이 없다. 선택적으로 GitHub 저장소에 자동 동기화한다.

## 도구

- `write_journal` — 6개 섹션(reflections, observations, project_notes, user_context, technical_insights, world_knowledge)에 저널 작성
- `search_journal` — 시맨틱 검색 (`query`, `limit`, `sections`)
- `read_journal` — `path`로 항목 전체 읽기
- `list_journal` — 최근 항목 목록 (`limit`, `days`)

## 저장 위치 (XDG)

- 데이터: `$PRIVATE_JOURNAL_PATH` > `$XDG_DATA_HOME/private-journal` > `~/.local/share/private-journal`
- 모델 캐시: `$XDG_CACHE_HOME/private-journal/models` > `~/.cache/private-journal/models`

임베딩 모델: `Xenova/multilingual-e5-small` (한국어 포함 다국어, 로컬 실행).

## 설치 / 빌드

```bash
npm install
npm run build
```

## Claude Code에 등록

```bash
claude mcp add private-journal -- node /절대경로/private-journal-mcp/dist/index.js
```

## Git 동기화 (선택)

`gh auth login`이 되어 있어야 한다. 환경변수로 원격을 지정한다:

```bash
export PRIVATE_JOURNAL_GIT_REMOTE="git@github.com:youruser/my-journal.git"
```

- 저장(`write_journal`) 시 서버가 자동으로 commit + push 한다 (best-effort).
- 세션 시작 시 최신화(pull)는 아래 hook으로 처리한다.

### SessionStart hook (pull)

`~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "node /절대경로/private-journal-mcp/dist/index.js sync" }
        ]
      }
    ]
  }
}
```

### 충돌 해소

여러 머신에서 같은 저장소를 쓸 때, 같은 파일명이 충돌하면 frontmatter의
`timestamp`가 더 최신인 항목을 채택한다(동점이면 로컬 우선). 서로 다른 항목은
파일명에 마이크로초가 포함되어 자동 병합된다.
````

- [ ] **Step 5: 전체 테스트 회귀 + 빌드 최종 확인**

Run: `npx jest && npm run build`
Expected: 전체 PASS(e2e는 skip), 빌드 성공.

- [ ] **Step 6: Commit**

```bash
git add README.md test/e2e.manual.test.ts .gitignore
git commit -m "docs: README + hook 등록 예시 + 옵트인 e2e"
```

---

## 완료 기준 (전체)

- `npx jest` 전체 통과 (e2e는 기본 skip).
- `npm run build` 성공, `dist/index.js` 생성.
- `node dist/index.js sync` (remote 미설정) no-op 종료.
- `RUN_E2E=1 npx jest test/e2e.manual.test.ts` 통과 (실모델 검색 동작).
- spec(2026-06-25-private-journal-mcp-design.md)의 모든 섹션이 task로 구현됨.
