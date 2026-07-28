# Git 동기화 원자성 개선 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 저널 항목을 쓰는 순간 원격 `main`에 원자적으로 반영하고, 여러 컴퓨터에서 동시에 쓸 때도 repo가 복구 불가능한 상태로 남지 않게 한다.

**Architecture:** 기존 `GitSync`에 네 가지를 더한다 — 네트워크 명령에만 걸리는 타임아웃, rebase 잔여 상태 복구, 기기 내 동시성용 파일 록, 기기 간 push 경쟁용 재시도 확대. `handleWrite`의 fire-and-forget을 `await`로 바꿔 push 완료를 보장한다. 새 모듈을 만들지 않고 `src/git-sync.ts` 안에서 해결한다 — 록과 타임아웃은 git 실행 경로에 밀착된 관심사고, 분리하면 오히려 호출 흐름이 흩어진다.

**Tech Stack:** TypeScript, Node `child_process.execFile`, Jest + ts-jest. 새 의존성 없음.

## Global Constraints

- 새 npm 의존성을 추가하지 않는다. `child_process`/`fs/promises`만 쓴다.
- 모든 git 실패는 best-effort로 삼킨다. 저널 쓰기 자체가 실패하면 안 된다.
- 로그 접두사는 기존과 동일하게 `[private-journal]`을 쓴다.
- `.embedding`은 계속 커밋한다. 커밋 제외는 이 계획의 범위가 아니다.
- 주기적 pull, 인터벌 타이머, 백그라운드 데몬을 추가하지 않는다. 동기화는 쓰기 시점에만 일어난다.
- 타임아웃 기본값 10000ms (`PRIVATE_JOURNAL_GIT_TIMEOUT_MS`로 조정), stale 록 임계값 120000ms.
- 록 파일명 `.private-journal-sync.lock`, 데이터 디렉터리 루트에 둔다.
- 기존 `chooseConflictWinner` 충돌 규칙(timestamp 큰 쪽 승리, 동일 시 로컬)을 바꾸지 않는다.
- 테스트는 `test/git-sync.test.ts`의 기존 헬퍼(`md`, `configureGitIdentity`, `currentBranch`, `createSeedRemote`)를 재사용한다.

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `src/git-sync.ts` | git 동기화 전체 | 타임아웃, rebase 복구, 록, 재시도, `.gitattributes` 생성 |
| `src/server.ts` | MCP 도구 핸들러 | `handleWrite`의 `void` → `await` (1줄) |
| `test/git-sync.test.ts` | git 동기화 테스트 | Task 1~5의 테스트 추가 |
| `test/server.test.ts` | 서버 핸들러 테스트 | Task 6의 await 검증 |
| `.gitignore` | — | 록 파일 제외 |
| `README.md` | — | repo 생성/설정, 동기화 시점 문서화 |

---

### Task 1: 네트워크 명령 타임아웃

**Files:**
- Modify: `src/git-sync.ts:7` (run 헬퍼), `src/git-sync.ts:48-58` (git/gitAt)
- Test: `test/git-sync.test.ts`

**Interfaces:**
- Consumes: 없음 (첫 태스크)
- Produces: `resolveGitTimeoutMs(env?: NodeJS.ProcessEnv): number` — export. `runNet(args, cwd?)` private 메서드 — 네트워크 git 명령 실행용.

로컬 rebase에 타임아웃을 걸면 rebase 중간에 손을 떼서 repo가 진행 중 상태로 남는다. 그래서 타임아웃은 `ls-remote`/`push`/`fetch`/`clone`에만 적용하고 로컬 명령에는 걸지 않는다.

- [ ] **Step 1: 실패하는 테스트 작성**

`test/git-sync.test.ts` 맨 아래에 추가:

```typescript
import { chooseConflictWinner, GitSync, resolveGitTimeoutMs } from '../src/git-sync';

describe('resolveGitTimeoutMs', () => {
  it('defaults to 10000ms', () => {
    expect(resolveGitTimeoutMs({})).toBe(10000);
  });
  it('reads PRIVATE_JOURNAL_GIT_TIMEOUT_MS', () => {
    expect(resolveGitTimeoutMs({ PRIVATE_JOURNAL_GIT_TIMEOUT_MS: '500' })).toBe(500);
  });
  it('ignores non-numeric values', () => {
    expect(resolveGitTimeoutMs({ PRIVATE_JOURNAL_GIT_TIMEOUT_MS: 'abc' })).toBe(10000);
  });
  it('ignores zero and negative values', () => {
    expect(resolveGitTimeoutMs({ PRIVATE_JOURNAL_GIT_TIMEOUT_MS: '0' })).toBe(10000);
    expect(resolveGitTimeoutMs({ PRIVATE_JOURNAL_GIT_TIMEOUT_MS: '-5' })).toBe(10000);
  });
});

describe('GitSync network timeout', () => {
  it('gives up on an unreachable remote and leaves no rebase state', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-timeout-'));
    // 라우팅되지 않는 주소 — 연결이 걸린 상태로 매달린다
    const gs = new GitSync(dir, 'git://10.255.255.1/nope.git');
    process.env.PRIVATE_JOURNAL_GIT_TIMEOUT_MS = '1000';
    try {
      const started = Date.now();
      await gs.ensureRepo();
      // 타임아웃 상한 안에서 돌아와야 한다 (여유 있게 15초)
      expect(Date.now() - started).toBeLessThan(15000);
      // rebase 진행 중 상태가 남지 않아야 한다
      await expect(fs.access(path.join(dir, '.git', 'rebase-merge'))).rejects.toBeDefined();
      await expect(fs.access(path.join(dir, '.git', 'rebase-apply'))).rejects.toBeDefined();
    } finally {
      delete process.env.PRIVATE_JOURNAL_GIT_TIMEOUT_MS;
    }
  }, 30000);
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest test/git-sync.test.ts -t "resolveGitTimeoutMs" -v`
Expected: FAIL — `resolveGitTimeoutMs is not a function` (아직 export 안 됨)

- [ ] **Step 3: 최소 구현**

`src/git-sync.ts:7` 아래에 추가:

```typescript
const DEFAULT_GIT_TIMEOUT_MS = 10000;

export function resolveGitTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PRIVATE_JOURNAL_GIT_TIMEOUT_MS;
  if (!raw) return DEFAULT_GIT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_GIT_TIMEOUT_MS;
  return parsed;
}
```

`GitSync` 클래스 안에 네트워크 전용 실행 메서드를 추가한다 (`gitAt` 바로 아래, `src/git-sync.ts:58` 이후):

```typescript
  private async runNet(args: string[], cwd: string = this.dataPath): Promise<{ stdout: string; stderr: string }> {
    return run('git', args, {
      cwd,
      env: gitEnv,
      timeout: resolveGitTimeoutMs(),
    });
  }
```

이제 네트워크를 타는 호출을 `runNet`으로 바꾼다. 각 위치의 기존 코드를 정확히 교체:

`ensureRepo` 안 (`src/git-sync.ts:67` 부근):
```typescript
        const { stdout } = await this.runNet(['ls-remote', this.remote!]);
```

`defaultRemoteBranch` 안 (`src/git-sync.ts:104` 부근):
```typescript
      const { stdout } = await this.runNet(['ls-remote', '--symref', this.remote!, 'HEAD']);
```

`clonePopulatedRemote` 안 (`src/git-sync.ts:141` 부근):
```typescript
      await this.runNet(['clone', '--no-checkout', this.remote!, clonePath]);
```

`pull` 안 (`src/git-sync.ts:191` 부근) — `pull --rebase`는 fetch(네트워크)와 rebase(로컬)가 한 명령에 묶여 있다. 타임아웃이 rebase를 자를 수 있으므로 **둘로 쪼갠다**. `pull` 메서드 본문의 try 블록을 이렇게 교체:

```typescript
  async pull(): Promise<void> {
    if (!this.enabled) return;
    if (!(await this.hasGitDir())) return;
    try {
      const branch = await this.currentBranch();
      await this.runNet(['fetch', 'origin', branch]);
      await this.git(['rebase', '--autostash', `origin/${branch}`]);
    } catch (err) {
      if (isRebaseConflictError(err)) {
        await this.resolveRebaseConflicts();
        return;
      }
      console.error('[private-journal] git pull failed (best-effort):', gitErrorText(err));
    }
  }
```

Task 3에서 이 본문을 `pullUnlocked`로 옮기고 `pull`은 록 래퍼가 된다. 지금은 이 형태로 둔다.

`commitAndPush` 안 push (`src/git-sync.ts:321` 부근):
```typescript
          await this.runNet(['push', '-u', 'origin', branch]);
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest test/git-sync.test.ts -v`
Expected: PASS — 기존 테스트 전부 + 새 타임아웃 테스트

`pull`을 fetch+rebase로 쪼갠 게 기존 충돌 해결 테스트를 깨뜨리지 않았는지 특히 확인한다. 깨지면 `resolveRebaseConflicts`의 stage 해석(`hasRebaseInProgress` 기반 ours/theirs 반전)이 `pull --rebase`와 `rebase` 사이에 달라졌는지 본다.

- [ ] **Step 5: 커밋**

```bash
git add src/git-sync.ts test/git-sync.test.ts
git commit -m "feat(git-sync): apply timeout to network git commands only"
```

---

### Task 2: rebase 잔여 상태 복구

**Files:**
- Modify: `src/git-sync.ts` (`commitAndPush` 진입부, `src/git-sync.ts:304` 부근)
- Test: `test/git-sync.test.ts`

**Interfaces:**
- Consumes: Task 1의 `runNet`
- Produces: `recoverFromInterruptedRebase(): Promise<void>` private 메서드

rebase가 중간에 끊기면 repo가 진행 중 상태로 남고, 이후 모든 `commit`이 실패해서 저널이 영구히 올라가지 않는다. 기존 `logUnresolvedRebaseState()`는 로그만 남기고 복구하지 않는다.

- [ ] **Step 1: 실패하는 테스트 작성**

**주의 — 빈 `.git/rebase-merge`는 실제 실패 조건이 아니다.** 실측 확인: 빈 디렉터리만 있으면 git은 커밋을 정상 수락한다(exit 0). 진짜 중단된 rebase는 인덱스에 unmerged 항목이 있어서 `error: Committing is not possible because you have unmerged files`로 커밋이 거부된다.

따라서 테스트가 **두 개** 필요하다.

**(a) 읽을 수 없는 rebase 상태 정리** — 아래 fabricated 버전. 이것이 증명하는 것은 강제 정리 경로이며, 테스트 이름도 그렇게 지어야 한다.

```typescript
describe('GitSync rebase recovery', () => {
  it('force-cleans unreadable rebase state and still commits', async () => {
    const { base, remote } = await createSeedRemote('gs-recover-');
    const dir = path.join(base, 'local');
    const gs = new GitSync(dir, remote);
    await gs.ensureRepo();
    await configureGitIdentity(dir);

    // head-name이 없는 불완전한 상태 — git이 읽지 못하므로 강제 정리 대상이다
    await fs.mkdir(path.join(dir, '.git', 'rebase-merge'), { recursive: true });

    // 새 항목을 쓰고 sync
    await fs.writeFile(path.join(dir, 'recovered.md'), md(500, 'recovered'), 'utf8');
    await gs.commitAndPush('after interruption');

    // rebase 상태가 정리되었다
    await expect(fs.access(path.join(dir, '.git', 'rebase-merge'))).rejects.toBeDefined();
    // 항목이 실제로 커밋되었다
    const { stdout } = await run('git', ['log', '--oneline'], { cwd: dir });
    expect(stdout).toContain('after interruption');
  }, 30000);
});
```

**(b) 진짜 충돌로 중단된 rebase** — 브리프가 의도한 주 경로(`resolveRebaseConflicts()`)를 실제로 타는 테스트. `test/git-sync.test.ts:191` 부근의 기존 `GitSync rebase conflict integration` 테스트가 실제 충돌을 만드는 패턴을 쓰고 있으니 그것을 따른다.

구성:

1. seed remote를 만들고 로컬 클론에서 같은 파일명을 서로 다른 `timestamp`로 커밋해 충돌을 만든다
2. `git rebase`가 실제로 충돌로 멈추게 둔다 — `.git/rebase-merge/head-name`이 존재하는 온전한 중단 상태
3. 이 상태에서 `commitAndPush`를 호출한다
4. 검증: rebase 상태가 정리되고, 커밋이 실제로 되고, **`timestamp`가 큰 쪽이 살아남는다**

4번의 마지막 항목이 핵심이다. 강제 정리 경로가 아니라 충돌 해결 경로를 탔음을 증명하는 유일한 신호다.

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest test/git-sync.test.ts -t "rebase recovery" -v`
Expected: FAIL — rebase-merge 디렉터리가 남아 있거나 커밋이 안 됨

- [ ] **Step 3: 최소 구현**

`hasRebaseInProgress` 아래에 추가:

```typescript
  private async recoverFromInterruptedRebase(): Promise<void> {
    if (!(await this.hasRebaseInProgress())) return;
    console.error('[private-journal] found interrupted rebase, recovering');
    await this.resolveRebaseConflicts();
    if (!(await this.hasRebaseInProgress())) return;
    try {
      await this.git(['rebase', '--abort']);
      console.error('[private-journal] aborted unrecoverable rebase (local commits preserved)');
    } catch (err) {
      logGitFailure('[private-journal] git rebase abort failed (best-effort):', err);
      // abort가 실패하는 경우는 두 가지다. rebase 상태 자체가 불완전해서 git이
      // 읽지 못하는 경우와, 온전한 상태인데 다른 이유(권한, 디스크)로 실패한
      // 경우. 전자만 강제 정리한다 — 온전한 상태를 지우면 git이 복구할 수
      // 있었던 작업 트리를 파괴한다. 이 경로가 없으면 읽을 수 없는 rebase
      // 상태에서 이후 모든 커밋이 영구히 실패한다.
      const gitDir = path.join(this.dataPath, '.git');
      if (await this.pathExists(path.join(gitDir, 'rebase-merge', 'head-name'))) {
        console.error('[private-journal] rebase state looks intact; leaving it for manual recovery');
        return;
      }
      try {
        await fs.rm(path.join(gitDir, 'rebase-merge'), { recursive: true, force: true });
        await fs.rm(path.join(gitDir, 'rebase-apply'), { recursive: true, force: true });
        console.error('[private-journal] force-cleaned unreadable rebase state');
      } catch (cleanupErr) {
        logGitFailure('[private-journal] cleanup of rebase directories failed (best-effort):', cleanupErr);
      }
    }
  }
```

`commitAndPush` 진입부(`src/git-sync.ts:305`의 `await this.ensureRepo();` 바로 뒤)에 삽입:

```typescript
      await this.recoverFromInterruptedRebase();
      await this.abortIfIndexUnmerged();
```

**데이터 손상 방어 (실측으로 확인된 필수 항목).** `git add -A`는 unmerged 경로를 내용 검증 없이 "해결됨"으로 스테이징한다. 인덱스에 충돌이 남아 있으면 conflict marker(`<<<<<<<`, `=======`, `>>>>>>>`)가 그대로 저널 파일에 박힌 채 커밋된다. 사용자 글이 깨진다.

이 경로는 강제 정리를 통해서도 도달한다. `rebase-merge` 디렉터리를 지워도 **인덱스의 unmerged 항목은 남으므로**, `hasRebaseInProgress()`가 false가 된 뒤 `add -A`가 마커를 커밋한다. 그래서 강제 정리 블록에 `git reset --mixed HEAD`를 넣고(작업 트리 내용은 보존), 추가로 커밋 직전 방어선을 둔다:

```typescript
  // add -A는 unmerged 경로를 내용 검증 없이 스테이징한다. 인덱스에 충돌이
  // 남아 있으면 conflict marker가 그대로 커밋되어 저널 파일이 손상된다.
  private async abortIfIndexUnmerged(): Promise<void> {
    try {
      const { stdout } = await this.git(['diff', '--name-only', '--diff-filter=U']);
      if (!stdout.trim()) return;
      console.error('[private-journal] index still has unmerged paths; resetting to avoid committing conflict markers');
      await this.git(['reset', '--mixed', 'HEAD']);
    } catch (err) {
      logGitFailure('[private-journal] unmerged index check failed (best-effort):', err);
    }
  }
```

`abortIfIndexUnmerged`는 **무조건** 호출한다. `hasRebaseInProgress()`로 가드하면 안 된다 — 실측 확인: rebase가 진행 중이고 복구가 실패한 상태에서 가드가 검사를 건너뛰면, 뒤따르는 `add -A` + `commit`이 마커를 그대로 커밋한다. 그 상황이 바로 이 방어선이 필요한 경우다.

테스트는 커밋된 파일에 `<<<<<<<`가 **없음**을 명시적으로 검증해야 한다. `timestamp` 승자만 확인하면 부족하다 — 마커가 박힌 파일에는 양쪽 내용이 다 남아서 승자 문자열도 포함되기 때문이다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest test/git-sync.test.ts -v`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/git-sync.ts test/git-sync.test.ts
git commit -m "feat(git-sync): recover from interrupted rebase on entry"
```

---

### Task 3: 기기 내 동시성 파일 록

**Files:**
- Modify: `src/git-sync.ts` (`pull`, `commitAndPush` 감싸기)
- Modify: `.gitignore`
- Test: `test/git-sync.test.ts`

**Interfaces:**
- Consumes: Task 2의 `recoverFromInterruptedRebase`
- Produces: `withLock<T>(fn: () => Promise<T>): Promise<T | undefined>` private 메서드. 록을 못 잡으면 `fn`을 실행하지 않고 `undefined` 반환. `LOCK_FILENAME = '.private-journal-sync.lock'`, `STALE_LOCK_MS = 120000` 상수.

같은 기기의 여러 세션이 각자 MCP 서버를 띄우면 같은 repo를 동시에 건드린다. git `index.lock` 충돌뿐 아니라 한쪽의 rebase 중간 상태를 다른 쪽이 깨뜨린다.

록을 못 잡으면 **기다리지 않고 skip한다.** 커밋되지 않은 항목은 다음 sync의 `git add -A`가 쓸어담으므로 유실이 없다.

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
describe('GitSync file lock', () => {
  it('skips sync when the lock is already held', async () => {
    const { base, remote } = await createSeedRemote('gs-lock-');
    const dir = path.join(base, 'local');
    const gs = new GitSync(dir, remote);
    await gs.ensureRepo();
    await configureGitIdentity(dir);

    // 다른 세션이 방금 록을 잡은 것처럼 만든다
    await fs.writeFile(
      path.join(dir, '.private-journal-sync.lock'),
      JSON.stringify({ pid: 999999, acquiredAt: Date.now() }),
      'utf8',
    );

    await fs.writeFile(path.join(dir, 'skipped.md'), md(600, 'skipped'), 'utf8');
    await gs.commitAndPush('should be skipped');

    const { stdout } = await run('git', ['log', '--oneline'], { cwd: dir });
    expect(stdout).not.toContain('should be skipped');
  }, 30000);

  it('steals a stale lock', async () => {
    const { base, remote } = await createSeedRemote('gs-stale-');
    const dir = path.join(base, 'local');
    const gs = new GitSync(dir, remote);
    await gs.ensureRepo();
    await configureGitIdentity(dir);

    // 임계값(120초)보다 오래된 록
    await fs.writeFile(
      path.join(dir, '.private-journal-sync.lock'),
      JSON.stringify({ pid: 999999, acquiredAt: Date.now() - 200000 }),
      'utf8',
    );

    await fs.writeFile(path.join(dir, 'stolen.md'), md(700, 'stolen'), 'utf8');
    await gs.commitAndPush('after stealing stale lock');

    const { stdout } = await run('git', ['log', '--oneline'], { cwd: dir });
    expect(stdout).toContain('after stealing stale lock');
  }, 30000);

  it('releases the lock after sync so the next call succeeds', async () => {
    const { base, remote } = await createSeedRemote('gs-release-');
    const dir = path.join(base, 'local');
    const gs = new GitSync(dir, remote);
    await gs.ensureRepo();
    await configureGitIdentity(dir);

    await fs.writeFile(path.join(dir, 'first.md'), md(800, 'first'), 'utf8');
    await gs.commitAndPush('first entry');
    // 록이 해제되어 파일이 남아있지 않다
    await expect(
      fs.access(path.join(dir, '.private-journal-sync.lock')),
    ).rejects.toBeDefined();

    await fs.writeFile(path.join(dir, 'second.md'), md(900, 'second'), 'utf8');
    await gs.commitAndPush('second entry');

    const { stdout } = await run('git', ['log', '--oneline'], { cwd: dir });
    expect(stdout).toContain('first entry');
    expect(stdout).toContain('second entry');
  }, 30000);

  it('picks up entries skipped by an earlier locked run', async () => {
    const { base, remote } = await createSeedRemote('gs-catchup-');
    const dir = path.join(base, 'local');
    const gs = new GitSync(dir, remote);
    await gs.ensureRepo();
    await configureGitIdentity(dir);

    const lockPath = path.join(dir, '.private-journal-sync.lock');
    await fs.writeFile(lockPath, JSON.stringify({ pid: 999999, acquiredAt: Date.now() }), 'utf8');
    await fs.writeFile(path.join(dir, 'deferred.md'), md(1000, 'deferred'), 'utf8');
    await gs.commitAndPush('skipped run');

    // 록이 풀린 뒤 다음 호출이 밀린 항목을 쓸어담는다
    await fs.rm(lockPath, { force: true });
    await gs.commitAndPush('catch-up run');

    const { stdout } = await run('git', ['ls-files'], { cwd: dir });
    expect(stdout).toContain('deferred.md');
  }, 30000);

  it('does not commit the lock file', async () => {
    const { base, remote } = await createSeedRemote('gs-lockignore-');
    const dir = path.join(base, 'local');
    const gs = new GitSync(dir, remote);
    await gs.ensureRepo();
    await configureGitIdentity(dir);

    await fs.writeFile(path.join(dir, 'entry2.md'), md(1100, 'e2'), 'utf8');
    await gs.commitAndPush('with lock ignored');

    const { stdout } = await run('git', ['ls-files'], { cwd: dir });
    expect(stdout).not.toContain('.private-journal-sync.lock');
  }, 30000);
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest test/git-sync.test.ts -t "file lock" -v`
Expected: FAIL — 록이 없으니 skip되지 않고 커밋됨

- [ ] **Step 3: 최소 구현**

파일 상단 상수에 추가:

```typescript
const LOCK_FILENAME = '.private-journal-sync.lock';
const STALE_LOCK_MS = 120000;
```

`GitSync` 클래스에 추가:

```typescript
  private get lockPath(): string {
    return path.join(this.dataPath, LOCK_FILENAME);
  }

  private async isStaleLock(): Promise<boolean> {
    try {
      const raw = await fs.readFile(this.lockPath, 'utf8');
      const { acquiredAt } = JSON.parse(raw) as { acquiredAt?: number };
      if (typeof acquiredAt !== 'number') return true;
      return Date.now() - acquiredAt > STALE_LOCK_MS;
    } catch {
      // 읽을 수 없거나 깨진 록은 stale로 본다
      return true;
    }
  }

  private async acquireLock(): Promise<boolean> {
    const payload = JSON.stringify({ pid: process.pid, acquiredAt: Date.now() });
    try {
      await fs.mkdir(this.dataPath, { recursive: true });
      await fs.writeFile(this.lockPath, payload, { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch {
      if (!(await this.isStaleLock())) return false;
      try {
        await fs.writeFile(this.lockPath, payload, 'utf8');
        console.error('[private-journal] stole stale sync lock');
        return true;
      } catch {
        return false;
      }
    }
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T | undefined> {
    if (!(await this.acquireLock())) {
      console.error('[private-journal] sync already in progress, skipping');
      return undefined;
    }
    try {
      return await fn();
    } finally {
      await fs.rm(this.lockPath, { force: true }).catch(() => {});
    }
  }
```

`pull`과 `commitAndPush`를 록으로 감싼다. **내부 재귀 호출이 록을 다시 잡으면 데드락**이 되므로, 록 없는 내부 버전을 분리한다.

Task 1에서 만든 `pull` 본문을 `pullUnlocked`로 옮기고, `pull`은 록 래퍼로 바꾼다:

```typescript
  async pull(): Promise<void> {
    if (!this.enabled) return;
    if (!(await this.hasGitDir())) return;
    await this.withLock(() => this.pullUnlocked());
  }

  private async pullUnlocked(): Promise<void> {
    try {
      const branch = await this.currentBranch();
      await this.runNet(['fetch', 'origin', branch]);
      await this.git(['rebase', '--autostash', `origin/${branch}`]);
    } catch (err) {
      if (isRebaseConflictError(err)) {
        await this.resolveRebaseConflicts();
        return;
      }
      console.error('[private-journal] git pull failed (best-effort):', gitErrorText(err));
    }
  }
```

`commitAndPush`도 같은 방식으로 나눈다. 기존 본문 전체를 `commitAndPushUnlocked`로 옮기되, 내부 `await this.pull()`을 `await this.pullUnlocked()`로 바꿔 록 재진입을 막는다. 전체 코드:

```typescript
  async commitAndPush(message: string): Promise<void> {
    if (!this.enabled) return;
    await this.withLock(() => this.commitAndPushUnlocked(message));
  }

  private async commitAndPushUnlocked(message: string): Promise<void> {
    try {
      await this.ensureRepo();
      await this.recoverFromInterruptedRebase();
      await this.git(['add', '-A']);
      try {
        await this.git(['commit', '-m', message]);
      } catch (err) {
        if (isNothingToCommitError(err)) {
          return;
        }
        logGitFailure('[private-journal] git commit failed (best-effort):', err);
        return;
      }
      const branch = await this.currentBranch();
      for (let attempt = 0; attempt < 2; attempt++) {
        await this.pullUnlocked();
        try {
          await this.runNet(['push', '-u', 'origin', branch]);
          return;
        } catch (err) {
          if (attempt === 1) {
            logGitFailure('[private-journal] git push failed (best-effort):', err);
          }
        }
      }
    } catch (err) {
      logGitFailure('[private-journal] git sync failed (best-effort):', err);
    }
  }
```

재시도 루프는 Task 5에서 5회+백오프로 바꾼다. 지금은 기존 2회를 유지한다.

`ensureRepo`가 `commitAndPushUnlocked` 안에서 호출되는데, `ensureRepo` 자체는 록을 잡지 않는다 (`pull`/`commitAndPush`만 감싼다). 그래서 재진입 문제가 없다.

`.gitignore`에 추가:

```
.private-journal-sync.lock
```

다만 데이터 repo의 `.gitignore`는 이 프로젝트 repo와 별개다. `ensureRepo`가 데이터 repo를 초기화할 때 록을 제외해야 한다. Task 4에서 `.gitattributes`와 함께 처리한다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest test/git-sync.test.ts -v`
Expected: PASS. `does not commit the lock file`은 Task 4의 exclude 파일 생성 전이면 실패할 수 있다 — 그 경우 Task 4까지 마친 뒤 재실행한다.

- [ ] **Step 5: 커밋**

```bash
git add src/git-sync.ts test/git-sync.test.ts .gitignore
git commit -m "feat(git-sync): add file lock to serialize same-machine sync"
```

---

### Task 4: 데이터 repo 메타파일 생성

**Files:**
- Modify: `src/git-sync.ts` (`ensureRepo`)
- Test: `test/git-sync.test.ts`

**Interfaces:**
- Consumes: Task 3의 `LOCK_FILENAME`
- Produces: `ensureRepoMetadata(): Promise<void>` private 메서드

`.embedding`은 바이너리다. git이 텍스트로 오판하면 rebase가 병합을 시도해서 벡터 파일을 깨뜨린다. `.gitattributes`로 막는다. 록 파일도 데이터 repo에서 제외해야 한다.

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
describe('GitSync repo metadata', () => {
  it('creates .gitattributes marking .embedding as binary', async () => {
    const { base, remote } = await createSeedRemote('gs-attrs-');
    const dir = path.join(base, 'local');
    const gs = new GitSync(dir, remote);
    await gs.ensureRepo();

    const attrs = await fs.readFile(path.join(dir, '.gitattributes'), 'utf8');
    expect(attrs).toContain('*.embedding binary');
  }, 30000);

  it('excludes the lock file from the data repo', async () => {
    const { base, remote } = await createSeedRemote('gs-exclude-');
    const dir = path.join(base, 'local');
    const gs = new GitSync(dir, remote);
    await gs.ensureRepo();
    await configureGitIdentity(dir);

    await fs.writeFile(path.join(dir, '.private-journal-sync.lock'), '{}', 'utf8');
    const { stdout } = await run('git', ['status', '--porcelain'], { cwd: dir });
    expect(stdout).not.toContain('.private-journal-sync.lock');
  }, 30000);

  it('does not overwrite an existing .gitattributes', async () => {
    const { base, remote } = await createSeedRemote('gs-attrs-keep-');
    const dir = path.join(base, 'local');
    const gs = new GitSync(dir, remote);
    await gs.ensureRepo();
    await fs.writeFile(path.join(dir, '.gitattributes'), '# custom\n', 'utf8');

    await gs.ensureRepo(); // 두 번째 호출
    const attrs = await fs.readFile(path.join(dir, '.gitattributes'), 'utf8');
    expect(attrs).toBe('# custom\n');
  }, 30000);
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest test/git-sync.test.ts -t "repo metadata" -v`
Expected: FAIL — `.gitattributes` 없음 (ENOENT)

- [ ] **Step 3: 최소 구현**

`GitSync`에 추가:

```typescript
  private async ensureRepoMetadata(): Promise<void> {
    const attrsPath = path.join(this.dataPath, '.gitattributes');
    if (!(await this.pathExists(attrsPath))) {
      await fs.writeFile(attrsPath, '*.embedding binary\n', 'utf8');
    }
    // 록 파일은 데이터 repo에 커밋되면 안 된다.
    // .gitignore가 아니라 .git/info/exclude를 쓴다 — 사용자의 .gitignore를 건드리지 않고
    // 원격에 퍼지지도 않는다.
    const excludePath = path.join(this.dataPath, '.git', 'info', 'exclude');
    try {
      await fs.mkdir(path.dirname(excludePath), { recursive: true });
      let current = '';
      try {
        current = await fs.readFile(excludePath, 'utf8');
      } catch { /* 파일이 없으면 새로 만든다 */ }
      if (!current.includes(LOCK_FILENAME)) {
        await fs.appendFile(excludePath, `\n${LOCK_FILENAME}\n`, 'utf8');
      }
    } catch (err) {
      logGitFailure('[private-journal] git exclude setup failed (best-effort):', err);
    }
  }
```

`ensureRepo`를 수정한다. 기존 코드는 `.git`이 있으면 바로 리턴하는데(`src/git-sync.ts:62`), 메타파일은 매번 확인해야 한다:

```typescript
  async ensureRepo(): Promise<void> {
    if (!this.enabled) return;
    if (await this.hasGitDir()) {
      await this.ensureRepoMetadata();
      return;
    }
    try {
      await fs.mkdir(this.dataPath, { recursive: true });
      try {
        const { stdout } = await this.runNet(['ls-remote', this.remote!]);
        if (stdout.trim().length > 0) {
          await this.clonePopulatedRemote();
          await this.ensureRepoMetadata();
          return;
        }
        await this.git(['init']);
        await this.git(['remote', 'add', 'origin', this.remote!]);
        await this.ensureRepoMetadata();
      } catch (err) {
        logGitFailure('[private-journal] git ls-remote failed (best-effort):', err);
        return;
      }
    } catch (err) {
      logGitFailure('[private-journal] git ensureRepo failed (best-effort):', err);
    }
  }
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest test/git-sync.test.ts -v`
Expected: PASS — Task 3의 `does not commit the lock file`도 이제 통과한다

- [ ] **Step 5: 커밋**

```bash
git add src/git-sync.ts test/git-sync.test.ts
git commit -m "feat(git-sync): create .gitattributes and exclude lock file"
```

---

### Task 5: 기기 간 push 재시도 확대

**Files:**
- Modify: `src/git-sync.ts:319` 부근 (재시도 루프)
- Test: `test/git-sync.test.ts`

**Interfaces:**
- Consumes: Task 3의 `commitAndPushUnlocked`, `pullUnlocked`
- Produces: `PUSH_RETRY_LIMIT = 5` 상수

파일 록은 기기 간에 무의미하다 — 서로 다른 컴퓨터는 파일시스템이 다르므로 서로의 록을 못 본다. 기기 간 동시성을 보장하는 건 록이 아니라 rebase와 push 재시도다. 현재 2회는 여러 대일 때 부족하다.

**이 태스크의 테스트가 이 계획 전체의 핵심 검증이다.**

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
describe('GitSync multi-machine concurrency', () => {
  it('preserves entries from two machines pushing alternately', async () => {
    const { base, remote } = await createSeedRemote('gs-multi-');
    const machineA = path.join(base, 'machineA');
    const machineB = path.join(base, 'machineB');

    const gsA = new GitSync(machineA, remote);
    const gsB = new GitSync(machineB, remote);
    await gsA.ensureRepo();
    await gsB.ensureRepo();
    await configureGitIdentity(machineA);
    await configureGitIdentity(machineB);

    // 각 기기가 서로 다른 파일명으로 항목을 쓴다 (실제로는 마이크로초 접미사)
    await fs.writeFile(path.join(machineA, 'a-000001.md'), md(2000, 'from A'), 'utf8');
    await fs.writeFile(path.join(machineB, 'b-000002.md'), md(2001, 'from B'), 'utf8');

    // 번갈아 push — B는 A가 먼저 올린 것을 rebase해야 한다
    await gsA.commitAndPush('entry from A');
    await gsB.commitAndPush('entry from B');

    // 세 번째 클론에서 확인: 양쪽 항목이 모두 살아있다
    const verify = path.join(base, 'verify');
    await run('git', ['clone', remote, verify]);
    const files = await fs.readdir(verify);
    expect(files).toContain('a-000001.md');
    expect(files).toContain('b-000002.md');

    // rebase가 깨끗하게 끝났다
    await expect(fs.access(path.join(machineB, '.git', 'rebase-merge'))).rejects.toBeDefined();
    await expect(fs.access(path.join(machineB, '.git', 'rebase-apply'))).rejects.toBeDefined();
  }, 60000);

  it('converges when both machines push before pulling', async () => {
    const { base, remote } = await createSeedRemote('gs-race-');
    const machineA = path.join(base, 'machineA');
    const machineB = path.join(base, 'machineB');

    const gsA = new GitSync(machineA, remote);
    const gsB = new GitSync(machineB, remote);
    await gsA.ensureRepo();
    await gsB.ensureRepo();
    await configureGitIdentity(machineA);
    await configureGitIdentity(machineB);

    // 양쪽이 서로를 모르는 상태에서 각각 쓴다
    await fs.writeFile(path.join(machineA, 'race-a.md'), md(3000, 'race A'), 'utf8');
    await fs.writeFile(path.join(machineB, 'race-b.md'), md(3001, 'race B'), 'utf8');

    // 동시에 push 시도 — 한쪽은 반드시 거부당하고 재시도로 수습해야 한다
    await Promise.all([
      gsA.commitAndPush('race from A'),
      gsB.commitAndPush('race from B'),
    ]);

    // 뒤처진 쪽이 따라잡을 기회를 준다
    await gsA.commitAndPush('catch up A');
    await gsB.commitAndPush('catch up B');

    const verify = path.join(base, 'verify');
    await run('git', ['clone', remote, verify]);
    const files = await fs.readdir(verify);
    expect(files).toContain('race-a.md');
    expect(files).toContain('race-b.md');
  }, 60000);
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest test/git-sync.test.ts -t "multi-machine" -v`
Expected: 두 번째 테스트(`converges when both machines push`)가 FAIL하거나 불안정하다 — 재시도 2회로는 경쟁을 수습하지 못한다. 첫 번째는 순차 push라 통과할 수 있다.

- [ ] **Step 3: 최소 구현**

상수 추가:

```typescript
const PUSH_RETRY_LIMIT = 5;
```

`commitAndPushUnlocked` 안의 재시도 루프를 백오프와 함께 교체:

```typescript
      const branch = await this.currentBranch();
      for (let attempt = 0; attempt < PUSH_RETRY_LIMIT; attempt++) {
        await this.pullUnlocked();
        try {
          await this.runNet(['push', '-u', 'origin', branch]);
          return;
        } catch (err) {
          if (attempt === PUSH_RETRY_LIMIT - 1) {
            logGitFailure('[private-journal] git push failed (best-effort):', err);
            return;
          }
          // 지수 백오프: 100ms, 200ms, 400ms, 800ms
          const delay = 100 * 2 ** attempt;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest test/git-sync.test.ts -v`
Expected: PASS

경쟁 테스트는 본질적으로 타이밍에 의존한다. 3회 연속 돌려 안정성을 확인한다:
```bash
for i in 1 2 3; do npx jest test/git-sync.test.ts -t "multi-machine" || break; done
```

- [ ] **Step 5: 커밋**

```bash
git add src/git-sync.ts test/git-sync.test.ts
git commit -m "feat(git-sync): raise push retries to 5 with exponential backoff"
```

---

### Task 6: handleWrite를 await로

**Files:**
- Modify: `src/server.ts:116-118`
- Test: `test/server.test.ts`

**Interfaces:**
- Consumes: Task 5까지의 `GitSync.commitAndPush`
- Produces: 없음 (동작 변경만)

현재 `void this.git.commitAndPush(...)`는 push 완료를 기다리지 않는다. 세션이 종료되면 커밋이 로컬에만 남는다. 이게 "쓰는 순간 원격에 반영"을 깨는 마지막 구멍이다.

**전역 상한 15초 (Task 5 이후 추가된 요구사항).** Task 5가 재시도를 5회로 늘렸으므로 `await`만 걸면 최악의 경우 약 111초가 걸린다 — 5회 × (fetch 10s + push 10s) + `ls-remote` 10s. 대화 중간에 저널을 쓰는 도구가 2분을 붙잡는 것은 허용할 수 없다.

`SYNC_DEADLINE_MS = 15000`을 두고 `handleWrite`의 sync를 그 상한 안에서만 기다린다. 상한을 넘으면 기다림을 그만두고 도구는 리턴하되, **sync 자체는 백그라운드에서 계속 진행한다** — 커밋은 이미 로컬에 있고 push가 끝나면 원격에도 반영된다. 실패하거나 미완이면 다음 쓰기나 SessionStart 훅이 밀어낸다.

```typescript
const SYNC_DEADLINE_MS = 15000;

// handleWrite 안에서
const sync = this.git.commitAndPush(`journal: ${new Date().toISOString()}`)
  .catch((error: unknown) => {
    console.error('[private-journal] commitAndPush failed (best-effort):', error);
  });

let timer: NodeJS.Timeout | undefined;
const deadline = new Promise<void>((resolve) => {
  timer = setTimeout(() => {
    console.error('[private-journal] sync exceeded 15s; continuing in background');
    resolve();
  }, SYNC_DEADLINE_MS);
});
await Promise.race([sync, deadline]);
clearTimeout(timer);
```

`clearTimeout`이 필수다. 없으면 sync가 먼저 끝나도 타이머가 이벤트 루프를 15초간 붙잡아 프로세스 종료가 지연된다.

이것은 인터벌 타이머가 아니라 일회성 마감 시한이므로 "주기적 동기화 금지" 제약과 충돌하지 않는다.

- [ ] **Step 1: 실패하는 테스트 작성**

`test/server.test.ts`에 추가:

```typescript
describe('handleWrite git sync', () => {
  it('waits for commitAndPush before returning', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srv-await-'));
    const srv = new PrivateJournalServer({ dataPath: dir, remote: 'file:///nonexistent.git' });

    let finished = false;
    jest.spyOn((srv as unknown as { git: { commitAndPush: () => Promise<void> } }).git, 'commitAndPush')
      .mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        finished = true;
      });

    await srv.handleWrite({ content: 'sync test' });
    // await였다면 리턴 시점에 이미 끝났어야 한다
    expect(finished).toBe(true);
  });

  it('still succeeds when commitAndPush rejects', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srv-fail-'));
    const srv = new PrivateJournalServer({ dataPath: dir, remote: 'file:///nonexistent.git' });

    jest.spyOn((srv as unknown as { git: { commitAndPush: () => Promise<void> } }).git, 'commitAndPush')
      .mockRejectedValue(new Error('remote exploded'));

    const result = await srv.handleWrite({ content: 'still works' });
    expect(result.path).toContain('.md');
  });
});
```

`test/server.test.ts` 상단 import에 `os`가 없으면 추가한다:
```typescript
import * as os from 'os';
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest test/server.test.ts -t "git sync" -v`
Expected: 첫 테스트 FAIL — `expect(finished).toBe(true)` 이 `false`를 받는다 (fire-and-forget이라 안 기다림)

- [ ] **Step 3: 최소 구현**

`src/server.ts:116-118`을 교체:

```typescript
    await this.git.commitAndPush(`journal: ${new Date().toISOString()}`).catch((error: unknown) => {
      console.error('[private-journal] commitAndPush failed (best-effort):', error);
    });
```

`void` → `await`. `.catch`는 유지해서 실패가 저널 쓰기를 깨지 않게 한다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest test/server.test.ts -v`
Expected: PASS

전체 스위트도 확인:
```bash
npx jest
```

- [ ] **Step 5: 커밋**

```bash
git add src/server.ts test/server.test.ts
git commit -m "fix(server): await commitAndPush so writes reach the remote"
```

---

### Task 7: 문서화

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 1~6의 동작
- Produces: 없음

- [ ] **Step 1: README의 Git sync 섹션 갱신**

기존 "Behavior:" 항목(README의 sync 설명 부근)을 찾아 교체한다. 현재 내용:

```markdown
Behavior:

- Right after a `write_journal` save, it attempts `commit + pull --rebase + push` on a best-effort basis.
- `node dist/index.js sync` handles `pull` and pushing any pending commits before a session starts.
```

이렇게 바꾼다:

```markdown
### Setting up the remote

Create a private repo and point the server at it:

```bash
gh repo create <your-account>/private-journal-vault --private
export PRIVATE_JOURNAL_GIT_REMOTE=git@github.com:<your-account>/private-journal-vault.git
```

If the remote is empty, the data directory is initialized in place. If the remote
already has entries, it is cloned and merged with whatever is already local.

Behavior:

- A `write_journal` save **waits** for `commit + fetch + rebase + push` to finish
  before returning, so an entry reaches the remote as soon as it is written.
- Push is retried up to 5 times with exponential backoff, which lets several
  machines writing at once settle without losing entries.
- Network commands (`fetch`, `push`, `ls-remote`, `clone`) time out after 10s
  (`PRIVATE_JOURNAL_GIT_TIMEOUT_MS`). Local rebase is never interrupted — cutting
  a rebase short would leave the repo unable to commit.
- If a previous run left an interrupted rebase, the next sync resolves it, or
  aborts it as a last resort. Local commits are preserved either way.
- Sync is serialized per machine by `.private-journal-sync.lock`. When another
  session holds it, this run is skipped and the next one picks up the pending
  entries.
- Reads (`search_journal`, `list_journal`, `read_journal`) do not pull. A session
  sees the snapshot from when it started, plus anything it wrote itself. Changes
  from other machines arrive on the next session start or the next write.
- `node dist/index.js sync` pulls and pushes pending commits before a session starts.
```

- [ ] **Step 2: 충돌 처리 섹션 갱신**

기존 "## Conflict Handling" 섹션에 `.embedding` 바이너리 처리를 추가한다:

```markdown
## Conflict Handling

- Distinct entries mostly coexist automatically because filenames include a microsecond suffix.
- When two entries share a filename, the one with the larger frontmatter `timestamp` wins.
- If the `timestamp` is identical, the local version takes precedence.
- The `.embedding` file may be regenerated based on the adopted Markdown.
- `.gitattributes` marks `*.embedding` as binary so Git never tries to merge
  vector files line by line.
```

- [ ] **Step 3: 문서 정확성 확인**

README에 적은 내용이 실제 코드와 맞는지 확인한다:

```bash
grep -n "PRIVATE_JOURNAL_GIT_TIMEOUT_MS\|PUSH_RETRY_LIMIT\|LOCK_FILENAME" src/git-sync.ts
grep -n "await this.git.commitAndPush" src/server.ts
```

Expected: 환경변수명, 재시도 횟수, 록 파일명이 README와 일치한다.

- [ ] **Step 4: 커밋**

```bash
git add README.md
git commit -m "docs: document atomic git sync behavior and remote setup"
```

---

### Task 8: 전체 검증

**Files:**
- 없음 (검증만)

**Interfaces:**
- Consumes: Task 1~7 전체
- Produces: 없음

- [ ] **Step 1: 빌드하고 dist/ 커밋**

`dist/`는 git에 추적되며 플러그인으로 배포된다 (`.gitignore`의 `!dist/` 참고). Task 1~6이 `src/`만 바꿨으므로 `dist/`가 소스와 어긋난 상태다. 여기서 한 번에 맞춘다.

Run: `npm run build`
Expected: 타입 에러 없이 성공

```bash
git add dist/
git commit -m "build: rebuild dist for git sync changes"
```

`git status --porcelain`으로 워킹 트리가 깨끗한지 확인한다.

- [ ] **Step 2: 전체 테스트**

Run: `npx jest`
Expected: 전 스위트 PASS. `e2e.manual.test.ts`는 이름대로 수동이라 스킵될 수 있다.

- [ ] **Step 3: 경쟁 테스트 반복 실행**

타이밍 의존 테스트의 안정성을 확인한다:

```bash
for i in 1 2 3 4 5; do npx jest test/git-sync.test.ts || { echo "FAILED on run $i"; break; }; done
```

Expected: 5회 연속 PASS. 산발적으로 실패하면 백오프 지연이 부족한 것이므로 Task 5의 지연값을 올린다.

- [ ] **Step 4: 실제 remote로 수동 확인**

임시 bare repo로 실제 흐름을 확인한다:

```bash
TMP=$(mktemp -d)
git init --bare "$TMP/vault.git"
export PRIVATE_JOURNAL_PATH="$TMP/data"
export PRIVATE_JOURNAL_GIT_REMOTE="$TMP/vault.git"
node dist/index.js sync
echo "sync exit: $?"
```

Expected: 에러 없이 종료. `$TMP/data/.git`과 `$TMP/data/.gitattributes`가 생성되고, 록 파일은 남아있지 않다.

```bash
ls -a "$TMP/data"
cat "$TMP/data/.gitattributes"
cat "$TMP/data/.git/info/exclude" | tail -3
rm -rf "$TMP"
unset PRIVATE_JOURNAL_PATH PRIVATE_JOURNAL_GIT_REMOTE
```

- [ ] **Step 5: 커밋 (변경사항이 있는 경우만)**

검증 중 수정이 필요했다면:

```bash
git add -A
git commit -m "fix(git-sync): address issues found in full verification"
```
