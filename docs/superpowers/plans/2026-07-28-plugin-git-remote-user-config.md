# Plugin Git Remote User Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code가 plugin 활성화 시 Git remote 입력 필드를 보여주고, 빈 값은 local-only로, 입력값은 Git sync remote로 사용하게 한다.

**Architecture:** 기존 환경 설정 resolver가 모여 있는 `src/paths.ts`에 `resolveGitRemote()`를 추가한다. MCP server와 SessionStart `sync` 경로가 이 함수를 공유하고, Claude plugin manifest의 `userConfig.git_remote`가 subprocess에 제공하는 `CLAUDE_PLUGIN_OPTION_GIT_REMOTE`를 기존 env보다 우선한다.

**Tech Stack:** TypeScript, Node.js `process.env`, Jest/ts-jest, Claude Code plugin manifest

## Global Constraints

- `git_remote` 값이 있으면 Git sync를 활성화한다.
- `git_remote`가 없거나 공백뿐이면 local-only로 동작한다.
- 우선순위는 `opts.remote` → `CLAUDE_PLUGIN_OPTION_GIT_REMOTE` → `PRIVATE_JOURNAL_GIT_REMOTE` → local-only다.
- `CLAUDE_PLUGIN_OPTION_GIT_REMOTE`가 빈 문자열로 존재하면 legacy env로 fallback하지 않는다.
- 기존 `PRIVATE_JOURNAL_GIT_REMOTE`와 Codex plugin 동작을 유지한다.
- 별도 config 파일, interactive `configure` CLI, Git remote 자동 감지는 추가하지 않는다.
- remote URL을 사전 검증하거나 credential을 관리하지 않는다.

---

## File Structure

- `src/paths.ts`: data/model 경로와 Git remote 환경 설정을 순수 함수로 해석한다.
- `src/index.ts`: SessionStart에서 호출하는 `sync` command에 해석된 remote를 전달한다.
- `src/server.ts`: MCP write 경로의 `GitSync`에 같은 remote 해석 결과를 전달한다.
- `test/paths.test.ts`: remote 우선순위, 공백, local-only를 순수 함수 수준에서 검증한다.
- `test/index.test.ts`: `runSync()`가 공통 resolver의 결과로 `GitSync`를 생성하는지 검증한다.
- `test/plugin-manifest.test.ts`: Claude manifest의 user config 공개 계약을 검증한다.
- `.claude-plugin/plugin.json`: Claude가 활성화 시 보여줄 `git_remote` 입력 필드를 선언한다.
- `README.md`: Claude 설정 UI, local-only, legacy env 사용법을 문서화한다.
- `dist/paths.js`, `dist/index.js`, `dist/server.js`: `npm run build`로 생성되는 배포 산출물이다.

### Task 1: Git remote 설정 해석과 두 runtime 경로 통합

**Files:**
- Modify: `src/paths.ts`
- Modify: `src/index.ts:4-12`
- Modify: `src/server.ts:100-106`
- Modify: `test/paths.test.ts`
- Modify: `test/index.test.ts`
- Modify generated: `dist/paths.js`
- Modify generated: `dist/index.js`
- Modify generated: `dist/server.js`

**Interfaces:**
- Produces: `resolveGitRemote(explicit?: string, env?: NodeJS.ProcessEnv): string | undefined`
- Consumes: `GitSync(dataPath: string, remote: string | undefined)`

- [ ] **Step 1: `resolveGitRemote()`의 실패하는 우선순위 테스트 작성**

`test/paths.test.ts`의 import에 `resolveGitRemote`를 추가하고 아래 테스트를 넣는다.

```ts
describe('resolveGitRemote', () => {
  it('prefers an explicit remote and trims it', () => {
    expect(resolveGitRemote('  explicit.git  ', {
      CLAUDE_PLUGIN_OPTION_GIT_REMOTE: 'plugin.git',
      PRIVATE_JOURNAL_GIT_REMOTE: 'legacy.git',
    })).toBe('explicit.git');
  });

  it('prefers the Claude plugin option over the legacy env', () => {
    expect(resolveGitRemote(undefined, {
      CLAUDE_PLUGIN_OPTION_GIT_REMOTE: '  plugin.git  ',
      PRIVATE_JOURNAL_GIT_REMOTE: 'legacy.git',
    })).toBe('plugin.git');
  });

  it('treats an explicitly empty Claude plugin option as local-only', () => {
    expect(resolveGitRemote(undefined, {
      CLAUDE_PLUGIN_OPTION_GIT_REMOTE: '   ',
      PRIVATE_JOURNAL_GIT_REMOTE: 'legacy.git',
    })).toBeUndefined();
  });

  it('uses the legacy env when the Claude plugin option is absent', () => {
    expect(resolveGitRemote(undefined, {
      PRIVATE_JOURNAL_GIT_REMOTE: '  legacy.git  ',
    })).toBe('legacy.git');
  });

  it('returns undefined when no remote is configured', () => {
    expect(resolveGitRemote(undefined, {})).toBeUndefined();
  });
});
```

- [ ] **Step 2: resolver 테스트가 기능 부재로 실패하는지 확인**

Run:

```bash
npm test -- --runInBand test/paths.test.ts
```

Expected: FAIL because `resolveGitRemote` is not exported from `src/paths.ts`.

- [ ] **Step 3: 최소 `resolveGitRemote()` 구현**

`src/paths.ts`에 다음 함수를 추가한다.

```ts
export function resolveGitRemote(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  let remote: string | undefined;

  if (explicit !== undefined) {
    remote = explicit;
  } else if (Object.prototype.hasOwnProperty.call(env, 'CLAUDE_PLUGIN_OPTION_GIT_REMOTE')) {
    remote = env.CLAUDE_PLUGIN_OPTION_GIT_REMOTE;
  } else {
    remote = env.PRIVATE_JOURNAL_GIT_REMOTE;
  }

  const normalized = remote?.trim();
  return normalized || undefined;
}
```

- [ ] **Step 4: resolver 테스트 통과 확인**

Run:

```bash
npm test -- --runInBand test/paths.test.ts
```

Expected: PASS.

- [ ] **Step 5: `runSync()`가 공통 resolver를 사용하는 실패 테스트 작성**

`test/index.test.ts`의 `../src/paths` mock에 resolver를 추가한다.

```ts
const resolveGitRemote = jest.fn((remote?: string) => remote);

jest.mock('../src/paths', () => ({
  resolveDataPath,
  resolveGitRemote,
}));
```

`GitSync` mock을 assertion할 수 있게 import를 추가한다.

```ts
import { GitSync } from '../src/git-sync';
```

각 `beforeEach()`에서 resolver 구현과 mock 호출 기록을 초기화한다.

```ts
resolveGitRemote.mockReset();
resolveGitRemote.mockImplementation((remote?: string) => remote);
(GitSync as jest.Mock).mockClear();
```

다음 테스트를 `describe('runSync')`에 추가한다.

```ts
it('uses the shared resolver result as the GitSync remote', async () => {
  resolveGitRemote.mockReturnValue('resolved.git');

  await runSync({ dataPath: '/resolved/data/path' });

  expect(resolveGitRemote).toHaveBeenCalledWith(undefined);
  expect(GitSync).toHaveBeenCalledWith('/resolved/data/path', 'resolved.git');
  expect(ensureRepo).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 6: `runSync()` 통합 테스트가 예상대로 실패하는지 확인**

Run:

```bash
npm test -- --runInBand test/index.test.ts
```

Expected: FAIL because `runSync()` still reads `PRIVATE_JOURNAL_GIT_REMOTE` directly and does not call `resolveGitRemote`.

- [ ] **Step 7: `runSync()`와 `PrivateJournalServer`를 공통 resolver로 연결**

`src/index.ts`의 import와 remote 결정을 바꾼다.

```ts
import { resolveDataPath, resolveGitRemote } from './paths';

const remote = resolveGitRemote(opts.remote);
```

`src/server.ts`도 같은 함수를 import하고 constructor를 바꾼다.

```ts
import { resolveDataPath, resolveGitRemote } from './paths';

this.git = new GitSync(this.dataPath, resolveGitRemote(opts.remote));
```

- [ ] **Step 8: focused runtime 테스트 통과 확인**

Run:

```bash
npm test -- --runInBand test/paths.test.ts test/index.test.ts test/server.test.ts
```

Expected: PASS.

- [ ] **Step 9: TypeScript build로 배포 산출물 갱신**

Run:

```bash
npm run build
```

Expected: exit 0 and `dist/paths.js`, `dist/index.js`, `dist/server.js` reflect the new resolver.

- [ ] **Step 10: Task 1 변경 커밋**

```bash
git add src/paths.ts src/index.ts src/server.ts \
  test/paths.test.ts test/index.test.ts \
  dist/paths.js dist/index.js dist/server.js
git commit -m "feat: resolve git remote from plugin config"
```

### Task 2: Claude userConfig 계약과 사용자 문서

**Files:**
- Create: `test/plugin-manifest.test.ts`
- Modify: `.claude-plugin/plugin.json`
- Modify: `README.md:60-114`

**Interfaces:**
- Consumes: Claude Code plugin manifest `userConfig` schema
- Produces: optional string option `git_remote`, exported by Claude as `CLAUDE_PLUGIN_OPTION_GIT_REMOTE`

- [ ] **Step 1: Claude manifest 공개 계약의 실패 테스트 작성**

`test/plugin-manifest.test.ts`를 만든다.

```ts
import * as fs from 'fs';
import * as path from 'path';

describe('Claude plugin manifest', () => {
  it('offers an optional Git remote with local-only guidance', () => {
    const manifestPath = path.join(__dirname, '..', '.claude-plugin', 'plugin.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    expect(manifest.userConfig?.git_remote).toEqual({
      type: 'string',
      title: 'Git remote',
      description: '동기화할 Git remote URL입니다. 비워두면 local-only로 사용합니다.',
    });
  });
});
```

- [ ] **Step 2: manifest 테스트가 필드 부재로 실패하는지 확인**

Run:

```bash
npm test -- --runInBand test/plugin-manifest.test.ts
```

Expected: FAIL because `.claude-plugin/plugin.json` has no `userConfig.git_remote`.

- [ ] **Step 3: Claude manifest에 `userConfig.git_remote` 추가**

`.claude-plugin/plugin.json`의 `author`와 `mcpServers` 사이에 다음 필드를 추가한다.

```json
"userConfig": {
  "git_remote": {
    "type": "string",
    "title": "Git remote",
    "description": "동기화할 Git remote URL입니다. 비워두면 local-only로 사용합니다."
  }
},
```

`required`와 `default`를 넣지 않는다. 빈 값이 지원되는 선택 설정이어야 한다.

- [ ] **Step 4: manifest 테스트와 Claude schema validation 통과 확인**

Run:

```bash
npm test -- --runInBand test/plugin-manifest.test.ts
claude plugin validate --strict .
```

Expected: Jest PASS and Claude reports the plugin as valid.

- [ ] **Step 5: README의 설정 경로를 실제 UX에 맞게 수정**

`README.md`의 plugin install 설명과 Git Sync 절을 다음 내용으로 갱신한다.

````md
When Claude Code enables the plugin, it asks for an optional **Git remote**.
Enter a remote URL to enable Git sync, or leave it blank for local-only storage.
Run `/plugin configure` and select `private-journal-mcp` to change it later.

Claude Code passes this setting to the plugin as
`CLAUDE_PLUGIN_OPTION_GIT_REMOTE`. Existing Codex and manual MCP setups can
continue to use `PRIVATE_JOURNAL_GIT_REMOTE`:

```bash
export PRIVATE_JOURNAL_GIT_REMOTE="git@github.com:youruser/my-journal.git"
```
````

Git remote URL에는 credential이나 token을 넣지 말고 SSH 또는 Git credential
설정을 사용한다는 기존 prerequisite를 유지한다. SessionStart 절의 “env가 없으면
no-op” 설명은 “configured remote가 없으면 no-op”으로 바꾼다.

- [ ] **Step 6: 전체 회귀 테스트와 build 검증**

Run:

```bash
npm test -- --runInBand
npm run build
git diff --check
```

Expected: all Jest suites PASS, TypeScript build exits 0, and `git diff --check`
prints nothing.

- [ ] **Step 7: plugin option을 적용한 launcher smoke 검증**

빈 임시 data directory를 만들고 로컬 bare remote를 사용한다.

```bash
tmp_root="$(mktemp -d)"
git init --bare "$tmp_root/remote.git"
CLAUDE_PLUGIN_OPTION_GIT_REMOTE="$tmp_root/remote.git" \
PRIVATE_JOURNAL_PATH="$tmp_root/journal" \
node dist/index.js sync
git -C "$tmp_root/journal" remote get-url origin
```

Expected: 마지막 명령이 `$tmp_root/remote.git`를 출력한다.

local-only도 별도 임시 directory에서 검증한다.

```bash
local_root="$(mktemp -d)"
CLAUDE_PLUGIN_OPTION_GIT_REMOTE="" \
PRIVATE_JOURNAL_GIT_REMOTE="/must/not/be/used.git" \
PRIVATE_JOURNAL_PATH="$local_root/journal" \
node dist/index.js sync
test ! -e "$local_root/journal/.git"
```

Expected: exit 0. 빈 Claude option이 legacy env를 차단해 `.git`이 생기지 않는다.

- [ ] **Step 8: Task 2 변경 커밋**

```bash
git add .claude-plugin/plugin.json README.md test/plugin-manifest.test.ts
git commit -m "feat: prompt for journal git remote in Claude"
```

- [ ] **Step 9: 최종 상태 확인**

Run:

```bash
git status --short --branch
git log --oneline -3
```

Expected: clean `feat/add-env` worktree with the design commit and two
implementation commits at HEAD.
